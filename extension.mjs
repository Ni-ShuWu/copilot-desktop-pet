// Extension: desktop-pet
// 类 Codex 桌宠扩展：
//   - Windows 桌面悬浮窗（WPF 透明置顶窗，pet-window.ps1）：真正在桌面走动的桌宠
//   - Copilot App 画布面板（pet.html）：预览动画 + 召唤/收回桌宠
//   - pet.json 配置贴图/动画/行为；agent 可通过 tools 或画布动作控制桌宠
//   - 监听会话事件：agent 工作时桌宠显示 🛠，任务完成时说话

import { createServer } from "node:http";
import { readFile, stat, readdir, writeFile, mkdir, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(EXT_DIR, "pet.json");
const HTML_FILE = path.join(EXT_DIR, "pet.html");
const PS1_FILE = path.join(EXT_DIR, "pet-window.ps1");

const DEFAULT_CONFIG = {
    name: "Copilot 桌宠",
    autoStart: false,
    sprite: "spritesheet.png",
    frameWidth: 32,
    frameHeight: 32,
    scale: 4,
    fps: 8,
    defaultAnimation: "idle",
    animations: { idle: { row: 0, frames: 4 } },
    behavior: { autoWander: true, walkSpeedPxPerSec: 40, wanderIntervalSec: [3, 8], sleepAfterIdleSec: 45 },
    speech: { phrases: ["(◕‿◕)"], fontSize: 13 },
};

let configCache = { mtimeMs: -1, config: DEFAULT_CONFIG, error: null };

async function readConfig(force) {
    try {
        const st = await stat(CONFIG_FILE);
        if (force || st.mtimeMs !== configCache.mtimeMs) {
            const raw = await readFile(CONFIG_FILE, "utf8");
            const parsed = JSON.parse(raw);
            configCache = {
                mtimeMs: st.mtimeMs,
                config: Object.assign({}, DEFAULT_CONFIG, parsed),
                error: null,
            };
        }
    } catch (err) {
        configCache = Object.assign({}, configCache, { error: String((err && err.message) || err) });
    }
    return configCache;
}

// ---- 桌宠共享状态（桌面窗与面板轮询获取） ----
const petState = {
    animation: null,      // 动画覆盖（null = 自动行为）
    message: null,
    messageUntil: 0,
    activity: "idle",     // idle | working（跟随 agent 状态）
};

const DONE_PHRASES = ["做完了。", "任务完成，去看看吧。", "嗯，都处理好了。", "收工。"];
let reviewToken = null;

let petProc = null;
let serverEntry = null;

function isPetRunning() {
    return !!petProc && petProc.exitCode === null && !petProc.killed;
}

// ---- 跨会话注册表：所有会话的扩展实例心跳到共享目录，互相感知工作状态 ----
const REG_DIR = path.join(os.tmpdir(), "copilot-desktop-pet");
const REG_FILE = path.join(REG_DIR, `inst-${process.pid}.json`);
const REG_STALE_MS = 12000;

function pidAlive(pid) {
    if (!pid || typeof pid !== "number") return false;
    try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

async function heartbeat() {
    try {
        await mkdir(REG_DIR, { recursive: true });
        await writeFile(REG_FILE, JSON.stringify({
            pid: process.pid,
            activity: petState.activity,
            petPid: isPetRunning() ? petProc.pid : null,
            ts: Date.now(),
        }));
    } catch {}
}

async function readRegistry() {
    const out = [];
    let names = [];
    try { names = await readdir(REG_DIR); } catch { return out; }
    const now = Date.now();
    for (const name of names) {
        if (!name.startsWith("inst-") || !name.endsWith(".json")) continue;
        const fp = path.join(REG_DIR, name);
        try {
            const e = JSON.parse(await readFile(fp, "utf8"));
            if (!e || typeof e.pid !== "number" || now - (e.ts || 0) > REG_STALE_MS || !pidAlive(e.pid)) {
                unlink(fp).catch(() => {});
                continue;
            }
            out.push(e);
        } catch {}
    }
    return out;
}

async function startDesktopPet() {
    if (isPetRunning()) return { ok: true, already: true, pid: petProc.pid };
    if (!serverEntry) return { ok: false, error: "local server not started" };
    const foreign = (await readRegistry()).find((e) => e.pid !== process.pid && pidAlive(e.petPid));
    if (foreign) return { ok: true, already: true, pid: foreign.petPid, foreign: true };
    petProc = spawn("powershell.exe", [
        "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
        "-File", PS1_FILE,
        "-ExtDir", EXT_DIR,
        "-StateUrl", serverEntry.url,
    ], { stdio: "ignore", windowsHide: true });
    petProc.on("exit", () => { petProc = null; });
    return { ok: true, pid: petProc.pid };
}

async function stopDesktopPet() {
    if (isPetRunning()) {
        try { process.kill(petProc.pid); } catch {}
        petProc = null;
        return { ok: true };
    }
    petProc = null;
    const foreign = (await readRegistry()).find((e) => e.pid !== process.pid && pidAlive(e.petPid));
    if (foreign) {
        try { process.kill(foreign.petPid); } catch {}
        return { ok: true, foreign: true };
    }
    return { ok: true, already: true };
}

function say(text, durationSec) {
    petState.message = String(text == null ? "" : text);
    petState.messageUntil = Date.now() + Math.max(1, Number(durationSec) || 4) * 1000;
    return { ok: true };
}

function setAnimation(anim, config) {
    if (anim === null || anim === undefined || anim === "" || anim === "auto") {
        petState.animation = null;
        return { ok: true, animation: null };
    }
    const animations = (config && config.animations) || {};
    if (!(anim in animations)) {
        return { ok: false, error: `unknown animation '${anim}'`, available: Object.keys(animations) };
    }
    petState.animation = anim;
    return { ok: true, animation: anim };
}

const IMAGE_MIME = { ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };

async function startServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://127.0.0.1");
            const p = url.pathname;
            res.setHeader("Cache-Control", "no-store");

            if (p === "/" || p === "/index.html") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(await readFile(HTML_FILE, "utf8"));
                return;
            }
            if (p === "/pet.json") {
                const { config, error } = await readConfig(false);
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify(error ? Object.assign({}, config, { _error: error }) : config));
                return;
            }
            if (p === "/api/state") {
                const entries = await readRegistry();
                const anyWorking = petState.activity === "working" || entries.some((e) => e.activity === "working");
                const foreignPet = entries.find((e) => e.pid !== process.pid && pidAlive(e.petPid));
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({
                    animation: petState.animation,
                    message: petState.message && Date.now() < petState.messageUntil ? petState.message : null,
                    activity: anyWorking ? "working" : "idle",
                    running: isPetRunning() || !!foreignPet,
                    sessions: entries.length,
                }));
                return;
            }
            if (p === "/api/sessions") {
                const entries = await readRegistry();
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify(entries.map((e) => ({
                    pid: e.pid,
                    self: e.pid === process.pid,
                    activity: e.activity,
                    petPid: e.petPid || null,
                    ageSec: Math.round((Date.now() - (e.ts || 0)) / 1000),
                }))));
                return;
            }
            if (p === "/api/pet/show" || p === "/api/pet/hide" || p === "/api/pet/toggle") {
                const r = p === "/api/pet/show" ? await startDesktopPet()
                        : p === "/api/pet/hide" ? await stopDesktopPet()
                        : (isPetRunning() ? await stopDesktopPet() : await startDesktopPet());
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify(r));
                return;
            }
            const ext = path.extname(p).toLowerCase();
            if (IMAGE_MIME[ext] && !p.includes("..")) {
                try {
                    const data = await readFile(path.join(EXT_DIR, path.basename(p)));
                    res.setHeader("Content-Type", IMAGE_MIME[ext]);
                    res.end(data);
                    return;
                } catch {}
            }
            res.statusCode = 404;
            res.end("not found");
        } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, port, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    tools: [
        {
            name: "desktop_pet_show",
            description: "在 Windows 桌面上召唤桌宠（透明置顶悬浮窗，类似 Codex 桌宠，会在桌面走动）。",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const r = await startDesktopPet();
                if (!r.ok) return { textResultForLlm: "桌宠启动失败: " + r.error, resultType: "failure" };
                if (r.foreign) return `另一会话的桌宠已在桌面上 (pid ${r.pid})，已联动其工作状态。`;
                return r.already ? "桌宠已经在桌面上了。" : `桌宠已出现在桌面上 (pid ${r.pid})。`;
            },
        },
        {
            name: "desktop_pet_hide",
            description: "收回桌面上的桌宠（关闭悬浮窗）。",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await stopDesktopPet();
                return "桌宠已收回。";
            },
        },
        {
            name: "desktop_pet_say",
            description: "让桌宠说一句话（气泡显示在桌宠上方）。",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "要说的内容" },
                    durationSec: { type: "number", description: "显示秒数，默认 4" },
                },
                required: ["text"],
            },
            handler: async (args) => {
                say(args.text, args.durationSec);
                return `桌宠说：${args.text}`;
            },
        },
        {
            name: "desktop_pet_set_animation",
            description: "让桌宠播放指定动画；传 auto 恢复自动行为。",
            parameters: {
                type: "object",
                properties: {
                    animation: { type: "string", description: "动画名（如 idle/walk/sleep），或 auto 恢复自动" },
                },
                required: ["animation"],
            },
            handler: async (args) => {
                const { config } = await readConfig(false);
                const r = setAnimation(args.animation, config);
                if (!r.ok) {
                    return { textResultForLlm: `${r.error}；可用动画: ${(r.available || []).join(", ")}`, resultType: "failure" };
                }
                return r.animation === null ? "已恢复自动行为。" : `动画已切换为 ${r.animation}。`;
            },
        },
        {
            name: "desktop_pet_reload",
            description: "重新读取 pet.json 配置（贴图/动画/行为热更新）。",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const { config, error } = await readConfig(true);
                if (error) return { textResultForLlm: "pet.json 读取失败: " + error, resultType: "failure" };
                return `配置已重载：${config.name}，动画: ${Object.keys(config.animations || {}).join(", ")}`;
            },
        },
    ],
    canvases: [
        createCanvas({
            id: "desktop-pet",
            displayName: "桌宠",
            description: "2D 桌宠面板：预览 spritesheet 动画，召唤/收回桌面桌宠（类 Codex 桌宠）",
            inputSchema: { type: "object", properties: {} },
            actions: [
                {
                    name: "show",
                    description: "召唤桌面桌宠悬浮窗",
                    inputSchema: { type: "object", properties: {} },
                    handler: async () => await startDesktopPet(),
                },
                {
                    name: "hide",
                    description: "收回桌面桌宠",
                    inputSchema: { type: "object", properties: {} },
                    handler: async () => await stopDesktopPet(),
                },
                {
                    name: "say",
                    description: "让桌宠说话",
                    inputSchema: {
                        type: "object",
                        properties: { text: { type: "string" }, durationSec: { type: "number" } },
                        required: ["text"],
                    },
                    handler: async (ctx) => say(ctx.input && ctx.input.text, ctx.input && ctx.input.durationSec),
                },
                {
                    name: "set_animation",
                    description: "切换动画，auto 恢复自动",
                    inputSchema: {
                        type: "object",
                        properties: { animation: { type: "string" } },
                        required: ["animation"],
                    },
                    handler: async (ctx) => {
                        const { config } = await readConfig(false);
                        return setAnimation(ctx.input && ctx.input.animation, config);
                    },
                },
                {
                    name: "reload_config",
                    description: "重读 pet.json 配置",
                    inputSchema: { type: "object", properties: {} },
                    handler: async () => {
                        const { config, error } = await readConfig(true);
                        return { ok: !error, error: error || undefined, animations: Object.keys(config.animations || {}) };
                    },
                },
            ],
            open: async () => ({ title: "桌宠", url: serverEntry.url }),
            onClose: () => {},
        }),
    ],
});

// ---- 会话事件 → 桌宠状态联动（类似 Codex companion 的反应） ----
session.on("tool.execution_start", () => { petState.activity = "working"; heartbeat(); });
session.on("session.idle", (event) => {
    const wasWorking = petState.activity === "working";
    petState.activity = "idle";
    heartbeat();
    if (wasWorking && isPetRunning() && !(event && event.data && event.data.aborted)) {
        say(DONE_PHRASES[Math.floor(Math.random() * DONE_PHRASES.length)], 4);
        if (!petState.animation) {
            petState.animation = "review";
            const token = (reviewToken = {});
            setTimeout(() => {
                if (reviewToken === token && petState.animation === "review") petState.animation = null;
            }, 6000);
        }
    }
});

// ---- 启动本地服务并注册清理 ----
serverEntry = await startServer();
await heartbeat();
setInterval(heartbeat, 3000);

// 打开 Copilot 自动召唤桌宠（pet.json autoStart；其他会话已有桌宠时不重复召唤）
const { config: bootCfg } = await readConfig(false);
if (bootCfg.autoStart) {
    startDesktopPet().then((r) => {
        if (r.ok && !r.already) session.log(`桌宠已自动召唤 (pid ${r.pid})`);
    }).catch(() => {});
}

function shutdown() {
    try { if (isPetRunning()) process.kill(petProc.pid); } catch {}
    try { serverEntry.server.close(); } catch {}
    try { unlinkSync(REG_FILE); } catch {}
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", shutdown);

await session.log(`桌宠扩展就绪 (${serverEntry.url})`);
