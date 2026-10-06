// Extension: desktop-pet
// 类 Codex 桌宠扩展：
//   - Windows 桌面悬浮窗（WPF 透明置顶窗，pet-window.ps1）：真正在桌面走动的桌宠
//   - Copilot App 画布面板（pet.html）：预览动画 + 召唤/收回桌宠
//   - pet.json 配置贴图/动画/行为；agent 可通过 tools 或画布动作控制桌宠
//   - 监听会话事件：agent 工作时桌宠显示 🛠，任务完成时说话
//   - 本地 HTTP 服务：外部程序也能直接推送 working / idle（externalEvents）
// 状态机与纯逻辑放在 state.mjs，本文件只负责 IO / 协议 / 进程管理。

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat, readdir, writeFile, mkdir, unlink, copyFile, rename } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import {
    DEFAULT_CONFIG,
    EXPLICIT_IDLE_SUPPRESS_MS,
    WORK_EVENTS,
    DONE_PHRASES,
    CRASH_PHRASES,
    clampPollMs,
    mergeConfig,
    createPetState,
    markWorking,
    markIdle,
    sanitizeActivity,
    computeActivity,
    say,
    visibleMessage,
    setAnimation,
    pickPhrase,
} from "./state.mjs";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(EXT_DIR, "pet.json");
const PET_LIBRARY_DIR = path.join(EXT_DIR, "pets");
const ACTIVE_PET_FILE = path.join(PET_LIBRARY_DIR, "active.json");
const HTML_FILE = path.join(EXT_DIR, "pet.html");
const PS1_FILE = path.join(EXT_DIR, "pet-window.ps1");

// 崩溃自愈：捕获到异常时先给桌宠放一段 failed 动画并冒泡，然后自愈，进程不退出
const CRASH_RECOVERY_MS = 5000;
const CRASH_WINDOW_MS = 60000;
const CRASH_TRIPLE = 3;
const BODY_LIMIT = 64 * 1024;
const PET_IMPORT_BODY_LIMIT = 17 * 1024 * 1024;

// 默认固定 10405：启动脚本与外部工具按固定端口找扩展；被占用时退回随机端口
const DEFAULT_HTTP_PORT = 10405;

const IMAGE_MIME = { ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };

// joinSession 在文件后半段才执行；异常处理器可能更早被触发，所以用可变引用避免 TDZ
let sessionRef = null;

let configCache = { mtimeMs: -1, config: DEFAULT_CONFIG, error: null };

async function readConfig(force) {
    try {
        const st = await stat(CONFIG_FILE);
        if (force || st.mtimeMs !== configCache.mtimeMs) {
            const raw = await readFile(CONFIG_FILE, "utf8");
            const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
            configCache = {
                mtimeMs: st.mtimeMs,
                config: mergeConfig(parsed),
                error: null,
            };
        }
    } catch (err) {
        configCache = Object.assign({}, configCache, { error: String((err && err.message) || err) });
    }
    return configCache;
}

function petLibraryPath(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
    return path.join(PET_LIBRARY_DIR, id);
}

function supportedSpriteExt(filename) {
    const ext = path.extname(String(filename || "")).toLowerCase();
    return Object.prototype.hasOwnProperty.call(IMAGE_MIME, ext) ? ext : null;
}

function matchesImageType(data, ext) {
    if (ext === ".png") return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (ext === ".gif") return data.subarray(0, 3).toString("ascii") === "GIF";
    return data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
}

// 外部工具生成的桌宠记录 JSON 用 cell 描述帧尺寸、没有 animations：
// 导入与切换统一走归一化，保证写出的 pet.json 桌面窗和面板都能直接用。
function normalizePetConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return cfg;
    if ((!cfg.frameWidth || !cfg.frameHeight)
        && Array.isArray(cfg.cell) && Number(cfg.cell[0]) > 0 && Number(cfg.cell[1]) > 0) {
        cfg.frameWidth = Number(cfg.cell[0]);
        cfg.frameHeight = Number(cfg.cell[1]);
        if (!cfg.scale) cfg.scale = 1;   // 记录格式贴图按原始像素尺寸展示
    }
    if (!cfg.animations || typeof cfg.animations !== "object"
        || Object.keys(cfg.animations).length === 0) {
        cfg.animations = Object.assign({}, DEFAULT_CONFIG.animations);
    }
    return cfg;
}

async function listPetLibrary() {
    await mkdir(PET_LIBRARY_DIR, { recursive: true });
    const pets = [];
    let activeId = "";
    try { activeId = JSON.parse(await readFile(ACTIVE_PET_FILE, "utf8")).id || ""; } catch {}
    for (const id of await readdir(PET_LIBRARY_DIR)) {
        const dir = petLibraryPath(id);
        if (!dir) continue;
        try {
            const cfg = JSON.parse((await readFile(path.join(dir, "pet.json"), "utf8")).replace(/^\uFEFF/, ""));
            pets.push({ id, name: String(cfg.name || "未命名桌宠"), sprite: String(cfg.sprite || "") });
        } catch {}
    }
    return { pets, activeId };
}

async function saveCurrentPet() {
    const { config, error } = await readConfig(true);
    if (error) return { ok: false, status: 400, error: "当前 pet.json 无法读取: " + error };
    const sprite = String(config.sprite || "");
    const ext = supportedSpriteExt(sprite);
    if (!ext || path.basename(sprite) !== sprite) {
        return { ok: false, status: 400, error: "当前配置引用了不支持的贴图文件" };
    }
    const spritePath = path.join(EXT_DIR, sprite);
    try { await stat(spritePath); } catch { return { ok: false, status: 400, error: "找不到当前桌宠贴图: " + sprite }; }

    const id = randomUUID();
    const dir = petLibraryPath(id);
    await mkdir(dir, { recursive: true });
    await copyFile(CONFIG_FILE, path.join(dir, "pet.json"));
    await copyFile(spritePath, path.join(dir, sprite));
    return { ok: true, pet: { id, name: String(config.name || "未命名桌宠"), sprite } };
}

async function importPet(body) {
    let cfg;
    try {
        cfg = typeof body.config === "string"
            ? JSON.parse(body.config.replace(/^\uFEFF/, ""))
            : body.config;
    } catch { return { ok: false, status: 400, error: "桌宠配置不是有效 JSON" }; }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, status: 400, error: "桌宠配置必须是 JSON 对象" };
    }
    cfg = normalizePetConfig(cfg);
    const ext = supportedSpriteExt(body.spriteName);
    if (!ext) return { ok: false, status: 400, error: "贴图仅支持 PNG、GIF 或 WebP" };
    const encoded = String(body.spriteData || "");
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        return { ok: false, status: 400, error: "贴图数据无效" };
    }
    const sprite = Buffer.from(encoded, "base64");
    if (!sprite.length || sprite.length > 12 * 1024 * 1024 || sprite.toString("base64") !== encoded || !matchesImageType(sprite, ext)) {
        return { ok: false, status: 400, error: "贴图内容无效、类型不匹配或超过 12 MB" };
    }

    const id = randomUUID();
    const dir = petLibraryPath(id);
    const spriteName = "spritesheet" + ext;
    cfg.sprite = spriteName;
    cfg.name = String(cfg.name || "未命名桌宠").slice(0, 100);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "pet.json"), JSON.stringify(cfg, null, 2), "utf8");
    await writeFile(path.join(dir, spriteName), sprite);
    return { ok: true, pet: { id, name: cfg.name, sprite: spriteName } };
}

async function activatePet(id) {
    const dir = petLibraryPath(id);
    if (!dir) return { ok: false, status: 400, error: "无效的桌宠编号" };
    let cfg;
    try { cfg = JSON.parse((await readFile(path.join(dir, "pet.json"), "utf8")).replace(/^\uFEFF/, "")); }
    catch { return { ok: false, status: 404, error: "找不到该桌宠配置" }; }
    cfg = normalizePetConfig(cfg);
    const sprite = String(cfg.sprite || "");
    const ext = supportedSpriteExt(sprite);
    if (!ext || path.basename(sprite) !== sprite) return { ok: false, status: 400, error: "桌宠贴图配置无效" };
    try { await stat(path.join(dir, sprite)); }
    catch { return { ok: false, status: 404, error: "桌宠贴图文件不存在" }; }

    const installedSprite = id + ext;
    await copyFile(path.join(dir, sprite), path.join(EXT_DIR, installedSprite));
    cfg.sprite = installedSprite;
    const tempConfig = CONFIG_FILE + "." + id + ".tmp";
    await writeFile(tempConfig, JSON.stringify(cfg, null, 2), "utf8");
    await rename(tempConfig, CONFIG_FILE);
    await writeFile(ACTIVE_PET_FILE, JSON.stringify({ id }), "utf8");
    const { config, error } = await readConfig(true);
    if (error) return { ok: false, status: 500, error };
    return { ok: true, config };
}

// ---- 桌宠共享状态（桌面窗与面板轮询/订阅获取） ----
const petState = createPetState(Date.now());

let reviewToken = null;
let crashTimes = [];
let petProc = null;
let serverEntry = null;
let bootCfg = DEFAULT_CONFIG;

function isPetRunning() {
    return !!petProc && petProc.exitCode === null && !petProc.killed;
}

// ---- 跨会话注册表：所有会话的扩展实例心跳到共享目录，互相感知工作状态 ----
const REG_DIR = path.join(os.tmpdir(), "copilot-desktop-pet");
const REG_FILE = path.join(REG_DIR, "inst-" + process.pid + ".json");
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
            // 端口与地址也写进心跳：外部工具（心跳模拟器、脚本）据此找到本机服务
            port: serverEntry ? serverEntry.port : null,
            url: serverEntry ? serverEntry.url : null,
            crashed: petState.crashed,
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

// ---- 兜底：未加载本扩展的会话，通过其事件日志最近是否有写入判断是否在工作 ----
// 注意：pet-window.ps1 的独立模式用同口径（6 秒写入窗口）本地检测 Copilot App 与会话活跃度，改动时请同步
const SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const ACTIVE_WINDOW_MS = 6000;
let activeCache = { ts: 0, value: false };

async function anySessionActive() {
    const now = Date.now();
    if (now - activeCache.ts < 1000) return activeCache.value;
    let active = false;
    try {
        const dirs = await readdir(SESSION_STATE_DIR);
        const results = await Promise.all(dirs.map(async (d) => {
            try {
                const st = await stat(path.join(SESSION_STATE_DIR, d, "events.jsonl"));
                return now - st.mtimeMs < ACTIVE_WINDOW_MS;
            } catch { return false; }
        }));
        active = results.some(Boolean);
    } catch {}
    activeCache = { ts: now, value: active };
    return active;
}

// ---- 本机 HTTP 服务 ----
const sseClients = new Set();
let lastBroadcast = "";

async function buildState() {
    const { config } = await readConfig(false);
    const entries = await readRegistry();
    const now = Date.now();
    const fallbackActive = await anySessionActive();
    const active = computeActivity({ state: petState, entries, now, fallbackActive });
    const foreignPet = entries.find((e) => e.pid !== process.pid && pidAlive(e.petPid));
    const ext = config.externalEvents || {};
    const enabled = !!(ext.enabled || process.env.PET_EXTERNAL_EVENTS === "1");
    const extPort = enabled ? (Number(ext.port) || (serverEntry ? serverEntry.port : 0)) : 0;
    return {
        animation: petState.animation,
        message: visibleMessage(petState, now),
        activity: active.activity,
        activitySource: active.source,
        running: isPetRunning() || !!foreignPet,
        sessions: entries.length,
        crashed: petState.crashed,
        pollIntervalMs: clampPollMs(config.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs),
        externalEvents: { enabled, port: extPort },
        pid: process.pid,
    };
}

function broadcast(payload) {
    for (const res of sseClients) {
        try { res.write("event: state\ndata: " + payload + "\n\n"); } catch {}
    }
}

async function broadcastState() {
    if (!sseClients.size) return;
    try {
        const payload = JSON.stringify(await buildState());
        if (payload === lastBroadcast) return;
        lastBroadcast = payload;
        broadcast(payload);
    } catch {}
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on("data", (chunk) => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > (limit || BODY_LIMIT)) {
                tooLarge = true;
                const error = new Error("request body too large");
                error.statusCode = 413;
                reject(error);
                req.resume();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8")); });
        req.on("error", (error) => { if (!tooLarge) reject(error); });
    });
}

function parseBody(raw) {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return null; }
}

function sendJson(res, obj, code) {
    res.statusCode = code || 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
}

// 外部推送鉴权：未开启 → 403；开启且配置了 token → 必须匹配（头 / query / body 任一）
async function authorizeExternal(req, url, body) {
    const { config } = await readConfig(false);
    const ext = config.externalEvents || {};
    const enabled = !!(ext.enabled || process.env.PET_EXTERNAL_EVENTS === "1");
    if (!enabled) {
        return { ok: false, code: 403, error: "external events are disabled (pet.json: externalEvents.enabled)" };
    }
    const token = String(ext.token || "");
    if (!token) return { ok: true };
    const given = req.headers["x-pet-token"] || url.searchParams.get("token") || (body && body.token) || "";
    if (String(given) !== token) return { ok: false, code: 401, error: "invalid token" };
    return { ok: true };
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

// 让桌宠说话：写状态 + 立刻推给订阅者（SSE 客户端毫秒级收到）
function petSay(text, durationSec) {
    const r = say(petState, text, durationSec, Date.now());
    broadcastState();
    return r;
}

function petSetAnimation(anim, config) {
    const r = setAnimation(petState, anim, config);
    broadcastState();
    return r;
}

function onWorkEvent() {
    markWorking(petState, Date.now());
    broadcastState();
}

function onIdle() {
    const { wasWorking } = markIdle(petState, Date.now(), { suppressMs: EXPLICIT_IDLE_SUPPRESS_MS });
    broadcastState();
    return wasWorking;
}

// ---- 崩溃自愈：异常不退出进程，先把「崩溃了」演出来，再恢复 ----
function handleCrash(kind, err) {
    try {
        const detail = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
        const now = Date.now();
        crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
        crashTimes.push(now);
        if (sessionRef) sessionRef.log("桌宠扩展捕获到 " + kind + "：" + String(detail).split("\n")[0]);
        const wasRunning = isPetRunning();
        petState.crashed = true;
        petState.animation = "failed";     // 没有 failed 动画时桌面窗会自动回退
        say(petState, pickPhrase(CRASH_PHRASES), 6, now);
        broadcastState();
        setTimeout(() => {
            try {
                petState.crashed = false;
                if (petState.animation === "failed") petState.animation = null;
                if (wasRunning && !isPetRunning()) startDesktopPet().catch(() => {});
                if (crashTimes.length >= CRASH_TRIPLE) {
                    // 连续崩溃：记录并复位计数，进程保持存活（绝不因异常退出）
                    if (sessionRef) sessionRef.log("桌宠扩展 60 秒内连续崩溃 " + crashTimes.length + " 次，已自愈并继续运行");
                    crashTimes = [];
                }
                broadcastState();
            } catch {}
        }, CRASH_RECOVERY_MS).unref?.();
    } catch {}
}

process.on("uncaughtException", (err) => handleCrash("uncaughtException", err));
process.on("unhandledRejection", (err) => handleCrash("unhandledRejection", err));

// 调试钩子：PET_SIMULATE_CRASH_MS=400 可在本地复现一次未捕获异常，验证自愈
if (process.env.PET_SIMULATE_CRASH_MS) {
    const ms = Number(process.env.PET_SIMULATE_CRASH_MS);
    if (Number.isFinite(ms) && ms > 0) {
        setTimeout(() => { throw new Error("simulated crash (PET_SIMULATE_CRASH_MS)"); }, ms).unref?.();
    }
}

async function startServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://127.0.0.1");
            const p = url.pathname;
            res.setHeader("Cache-Control", "no-store");
            const isPost = req.method === "POST";

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
                sendJson(res, await buildState());
                return;
            }
            if (p === "/api/sessions") {
                const entries = await readRegistry();
                sendJson(res, entries.map((e) => ({
                    pid: e.pid,
                    self: e.pid === process.pid,
                    activity: e.activity,
                    petPid: e.petPid || null,
                    port: e.port || null,
                    url: e.url || null,
                    ageSec: Math.round((Date.now() - (e.ts || 0)) / 1000),
                })));
                return;
            }
            // SSE：状态变化即推，最长 5 秒一次心跳注释
            if (p === "/api/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Connection": "keep-alive",
                });
                res.write("retry: 1000\n\n");
                sseClients.add(res);
                try { res.write("event: state\ndata: " + JSON.stringify(await buildState()) + "\n\n"); } catch {}
                req.on("close", () => sseClients.delete(res));
                return;
            }
            if (p === "/api/pets" && req.method === "GET") {
                const library = await listPetLibrary();
                sendJson(res, library);
                return;
            }
            if (p === "/api/pets/save" && isPost) {
                // 保存只是生成副本，不改变当前激活的桌宠
                const result = await saveCurrentPet();
                sendJson(res, result, result.ok ? 200 : result.status);
                return;
            }
            if (p === "/api/pets/import" && isPost) {
                const body = parseBody(await readBody(req, PET_IMPORT_BODY_LIMIT));
                if (body === null) { sendJson(res, { ok: false, error: "invalid json" }, 400); return; }
                const imported = await importPet(body);
                if (!imported.ok) { sendJson(res, imported, imported.status); return; }
                const result = await activatePet(imported.pet.id);
                if (!result.ok) { sendJson(res, result, result.status); return; }
                sendJson(res, imported);
                broadcastState();
                return;
            }
            if (p === "/api/pets/activate" && isPost) {
                const body = parseBody(await readBody(req));
                if (body === null) { sendJson(res, { ok: false, error: "invalid json" }, 400); return; }
                const result = await activatePet(body.id);
                sendJson(res, result, result.ok ? 200 : result.status);
                if (result.ok) broadcastState();
                return;
            }
            if (p === "/api/pet/show" || p === "/api/pet/hide" || p === "/api/pet/toggle") {
                const r = p === "/api/pet/show" ? await startDesktopPet()
                        : p === "/api/pet/hide" ? await stopDesktopPet()
                        : (isPetRunning() ? await stopDesktopPet() : await startDesktopPet());
                sendJson(res, r);
                broadcastState();
                return;
            }
            if (p === "/api/say" && isPost) {
                const body = parseBody(await readBody(req));
                if (body === null) { sendJson(res, { ok: false, error: "invalid json" }, 400); return; }
                if (!body.text) { sendJson(res, { ok: false, error: "text is required" }, 400); return; }
                sendJson(res, petSay(body.text, body.durationSec));
                return;
            }
            if (p === "/api/animation" && isPost) {
                const body = parseBody(await readBody(req));
                if (body === null) { sendJson(res, { ok: false, error: "invalid json" }, 400); return; }
                const { config } = await readConfig(false);
                const r = petSetAnimation(body.animation, config);
                sendJson(res, r, r.ok ? 200 : 400);
                return;
            }
            if (p === "/api/reload" && isPost) {
                const { config, error } = await readConfig(true);
                sendJson(res, {
                    ok: !error,
                    error: error || undefined,
                    animations: Object.keys(config.animations || {}),
                });
                broadcastState();
                return;
            }
            // ---- 外部事件：不装 Copilot 扩展也能驱动桌宠 ----
            if ((p === "/api/working" || p === "/api/idle" || p === "/api/activity") && isPost) {
                const body = parseBody(await readBody(req));
                if (body === null) { sendJson(res, { ok: false, error: "invalid json" }, 400); return; }
                const auth = await authorizeExternal(req, url, body);
                if (!auth.ok) { sendJson(res, { ok: false, error: auth.error }, auth.code); return; }
                // 想推多久由调用方决定：本接口不设超时，长期任务请成对推送 working / idle
                if (p === "/api/activity") {
                    const wanted = sanitizeActivity(body.activity);
                    if (!wanted) { sendJson(res, { ok: false, error: "activity must be working|idle" }, 400); return; }
                    if (wanted === "working") markWorking(petState, Date.now());
                    else markIdle(petState, Date.now(), { suppressMs: EXPLICIT_IDLE_SUPPRESS_MS });
                } else if (p === "/api/working") {
                    markWorking(petState, Date.now());
                } else {
                    markIdle(petState, Date.now(), { suppressMs: EXPLICIT_IDLE_SUPPRESS_MS });
                }
                const payload = await buildState();
                broadcast(JSON.stringify(payload));
                lastBroadcast = JSON.stringify(payload);
                sendJson(res, { ok: true, activity: payload.activity, source: body.source || "external" });
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
            if (!res.headersSent) {
                sendJson(res, { ok: false, error: err.message || String(err) }, err.statusCode || 500);
            } else {
                res.destroy(err);
            }
        }
    });
    const wanted = Number(process.env.PET_HTTP_PORT);
    let port = Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_HTTP_PORT;
    const listen = (p) => new Promise((resolve, reject) => {
        const onErr = (err) => { server.removeListener("listening", onOk); reject(err); };
        const onOk = () => { server.removeListener("error", onErr); resolve(); };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(p, "127.0.0.1");
    });
    try {
        await listen(port);
    } catch (err) {
        // 指定端口被占用时退回随机端口，保证扩展本体永远能起来
        if (!port) throw err;
        port = 0;
        await listen(0);
    }
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : 0;
    return { server, port: actual, url: "http://127.0.0.1:" + actual + "/" };
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
                if (r.foreign) return "另一会话的桌宠已在桌面上 (pid " + r.pid + ")，已联动其工作状态。";
                return r.already ? "桌宠已经在桌面上了。" : "桌宠已出现在桌面上 (pid " + r.pid + ")。";
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
                petSay(args.text, args.durationSec);
                return "桌宠说：" + args.text;
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
                const r = petSetAnimation(args.animation, config);
                if (!r.ok) {
                    return { textResultForLlm: r.error + "；可用动画: " + (r.available || []).join(", "), resultType: "failure" };
                }
                return r.animation === null ? "已恢复自动行为。" : "动画已切换为 " + r.animation + "。";
            },
        },
        {
            name: "desktop_pet_reload",
            description: "重新读取 pet.json 配置（贴图/动画/行为热更新）。",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const { config, error } = await readConfig(true);
                if (error) return { textResultForLlm: "pet.json 读取失败: " + error, resultType: "failure" };
                return "配置已重载：" + config.name + "，动画: " + Object.keys(config.animations || {}).join(", ");
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
                    handler: async (ctx) => petSay(ctx.input && ctx.input.text, ctx.input && ctx.input.durationSec),
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
                        return petSetAnimation(ctx.input && ctx.input.animation, config);
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

sessionRef = session;

// ---- 会话事件 → 桌宠状态联动（类似 Codex companion 的反应） ----
// 工作信号：立刻置 working（毫秒级），不再等桌面窗下一轮心跳/日志扫描
for (const ev of WORK_EVENTS) {
    try { session.on(ev, onWorkEvent); } catch {}
}
// session.idle：agent 收工的权威信号，立刻置 idle，并抑制事件日志兜底把状态拉回 working
session.on("session.idle", (event) => {
    const wasWorking = onIdle();
    if (wasWorking && isPetRunning() && !(event && event.data && event.data.aborted)) {
        petSay(pickPhrase(DONE_PHRASES), 4);
        if (!petState.animation) {
            petState.animation = "review";
            const token = (reviewToken = {});
            setTimeout(() => {
                // 只有「还是当初那次 review 覆盖」时才清空，避免误清新动画
                if (reviewToken === token && petState.animation === "review") {
                    petState.animation = null;
                    broadcastState();
                }
            }, 6000).unref?.();
            broadcastState();
        }
    }
});

// ---- 启动本地服务并注册清理 ----
serverEntry = await startServer();
await heartbeat();
setInterval(heartbeat, 3000).unref?.();

// SSE 推流：1 秒比对一次状态（外部推送 / 跨会话变化都能及时送达），5 秒一次心跳注释
setInterval(() => { broadcastState(); }, 1000).unref?.();
setInterval(() => {
    for (const res of sseClients) {
        try { res.write(": keepalive\n\n"); } catch {}
    }
}, 5000).unref?.();

// 打开 Copilot 自动召唤桌宠（pet.json autoStart；其他会话已有桌宠时不重复召唤）
bootCfg = (await readConfig(false)).config;
if (bootCfg.autoStart) {
    startDesktopPet().then((r) => {
        if (r.ok && !r.already) session.log("桌宠已自动召唤 (pid " + r.pid + ")");
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

await session.log("桌宠扩展就绪 (" + serverEntry.url + ")，外部事件推送: " +
    ((bootCfg.externalEvents && bootCfg.externalEvents.enabled) || process.env.PET_EXTERNAL_EVENTS === "1" ? "已开启" : "未开启"));
