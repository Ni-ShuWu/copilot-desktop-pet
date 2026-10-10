// tests/extension.test.mjs —— 集成测试（零依赖）
// 每个用例：仓库文件复制到临时目录 + SDK stub + pet.json + 空闲端口 + spawn extension.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeSandbox, startExtension, freePort, openSSE, waitFor, sleep, sdkEventFile, emitSessionEvent, readChatLog } from "./helpers.mjs";

const BASE_PET = {
    name: "测试桌宠",
    animations: {
        idle: { row: 0, frames: 4 },
        walk: { row: 1, frames: 4 },
        sleep: { row: 2, frames: 4 },
    },
    pollIntervalMs: 250,
    behavior: { autoWander: true, walkSpeedPxPerSec: 40, wanderIntervalSec: [3, 8], sleepAfterIdleSec: 45 },
    externalEvents: { enabled: false, port: 0, token: "" },
};

test("issue #8: 旧目录 JSON 修改在热更新和重启后同步，错误 JSON 保留上一份配置", async (t) => {
    const ext = await boot(t, {});
    const cfg = Object.assign({}, BASE_PET, { name: "旧目录的新配置", sprite: "spritesheet.png",
        scale: 2, behavior: { autoWander: false, lookAtCopilot: true } });
    await writeFile(path.join(ext.dir, "pet.json"), "\uFEFF" + JSON.stringify(cfg));
    const changed = await ext.request("GET", "/pet.json");
    assert.equal(changed.json.name, cfg.name);
    assert.equal(changed.json.scale, 2);
    assert.equal((await ext.request("GET", "/api/state")).json.lookAtCopilot, true);
    await writeFile(path.join(ext.dir, "pet.json"), "{");
    const invalid = await ext.request("GET", "/pet.json");
    assert.ok(invalid.json._error);
    assert.equal(invalid.json.name, cfg.name);
    await writeFile(path.join(ext.dir, "pet.json"), JSON.stringify({ ...cfg, name: "修正后的配置" }));
    assert.equal((await ext.request("GET", "/pet.json")).json.name, "修正后的配置");
    await ext.stop();
    await writeFile(path.join(ext.dir, "pet.json"), JSON.stringify({ ...cfg, name: "停机时修改" }));
    const restarted = await startExtension({ dir: ext.dir, env: { PET_HTTP_PORT: String(ext.port), PET_TEST_NO_SHELL: "1" } });
    try { assert.equal((await restarted.request("GET", "/pet.json")).json.name, "停机时修改"); }
    finally { await restarted.stop(); }
});

test("issue #8: 活动桌宠库 JSON 热改生效，直接修改工作副本不会被旧库配置覆盖", async (t) => {
    const ext = await boot(t, {});
    const sprite = await readFile(path.join(ext.dir, "assets", "octocat.png"));
    const result = await ext.request("POST", "/api/pets/import", { body: {
        config: { ...BASE_PET, frameWidth: 896, frameHeight: 896, name: "库内桌宠" },
        spriteName: "pet.png", spriteData: sprite.toString("base64"),
    } });
    assert.equal(result.status, 200, result.text);
    const root = path.join(ext.dir, "home", "AppData", "Roaming", "copilot-desktop-pet");
    const libraryFile = path.join(root, "pets", result.json.pet.id, "pet.json");
    const cfg = JSON.parse(await readFile(libraryFile, "utf8"));
    await writeFile(libraryFile, JSON.stringify({ ...cfg, name: "库内改名", behavior: { lookAtCopilot: true } }));
    assert.equal((await ext.request("GET", "/pet.json")).json.name, "库内改名");
    assert.equal((await ext.request("GET", "/api/state")).json.lookAtCopilot, true);
    const working = (await ext.request("GET", "/pet.json")).json;
    await writeFile(path.join(root, "pet.json"), JSON.stringify({ ...working, name: "工作副本改名" }));
    assert.equal((await ext.request("GET", "/pet.json")).json.name, "工作副本改名");
    assert.equal((await ext.request("GET", "/pet.json")).json.name, "工作副本改名");
    assert.equal((await ext.request("GET", "/api/pets")).json.activeId, result.json.pet.id);
});

test("issue #9: 内置默认桌宠、预览元数据、删除活动桌宠切换和最后一只保护", async (t) => {
    const sb = await makeSandbox();
    const port = await freePort();
    const ext = await startExtension({ dir: sb.dir, env: { PET_HTTP_PORT: String(port), PET_TEST_NO_SHELL: "1" } });
    t.after(async () => { await ext.stop(); await sb.cleanup(); });
    const builtin = (await ext.request("GET", "/api/pets")).json;
    assert.equal(builtin.pets.length, 1);
    assert.equal(builtin.activeId, builtin.pets[0].id);
    assert.equal(builtin.pets[0].frameWidth, 896);
    assert.equal(builtin.pets[0].frames, 1);
    const active = (await ext.request("GET", "/pet.json")).json;
    assert.equal((await ext.request("GET", "/" + active.sprite.replace(/\\/g, "/"))).status, 200);
    assert.equal((await ext.request("POST", "/api/pets/delete", { body: { id: builtin.activeId } })).status, 409);
    const saved = await ext.request("POST", "/api/pets/save");
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await ext.request("POST", "/api/pets/delete", { body: { id: "../outside" } })).status, 400);
    assert.equal((await ext.request("POST", "/api/pets/delete", { body: { id: builtin.activeId } })).status, 200);
    const next = (await ext.request("GET", "/api/pets")).json;
    assert.equal(next.activeId, saved.json.pet.id);
    assert.equal(next.pets.length, 1);
    assert.equal((await ext.request("GET", "/pets/" + builtin.activeId + "/octocat.png")).status, 404);
    assert.equal((await ext.request("GET", "/api/pets")).json.pets.length, 1, "删除内置桌宠后不应重新安装");
});

/** 起一个隔离沙箱 + 扩展进程；用例结束后自动清理进程与临时目录 */
async function boot(t, opts) {
    const o = opts || {};
    const sb = await makeSandbox({
        petJson: o.pet === undefined ? BASE_PET : o.pet,
        extraFiles: Object.assign({ "spritesheet.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) }, o.extraFiles || {}),
    });
    const port = await freePort();
    let ext;
    try {
        ext = await startExtension({
            dir: sb.dir,
            env: Object.assign({
                PET_HTTP_PORT: String(port),
                // 让 SDK stub 的会话事件控制通道与聊天留档都落在沙箱内
                PET_TEST_EVENTS_FILE: sdkEventFile(sb.dir),
                PET_TEST_CHAT_LOG: path.join(sb.dir, "tmp", "chat-log.jsonl"),
                // 测试环境不真的拉起资源管理器
                PET_TEST_NO_SHELL: "1",
            }, o.env || {}),
        });
    } catch (err) {
        await sb.cleanup();
        throw err;
    }
    t.after(async () => { await ext.stop(); await sb.cleanup(); });
    return ext;
}

function withExternal(pet, extra) {
    return Object.assign({}, pet, { externalEvents: Object.assign({ enabled: true, port: 0, token: "" }, extra || {}) });
}

test("两个会话共享配置和心跳：配置修改同时生效，工作状态跨会话可见", async (t) => {
    const cfg = withExternal(BASE_PET);
    const first = await boot(t, { pet: cfg });
    const sb = await makeSandbox({ petJson: cfg });
    const port = await freePort();
    const appdata = path.join(first.dir, "home", "AppData", "Roaming");
    let second;
    try {
        second = await startExtension({ dir: sb.dir, env: { PET_HTTP_PORT: String(port),
            APPDATA: appdata, TEMP: path.join(first.dir, "tmp"), TMP: path.join(first.dir, "tmp") } });
        const working = await first.request("POST", "/api/working", { body: {} });
        assert.equal(working.status, 200);
        await waitFor(async () => (await second.request("GET", "/api/state")).json.activity === "working",
            { timeoutMs: 6000, label: "shared registry activity" });
        const updated = { ...cfg, name: "两个会话都能看到", behavior: { lookAtCopilot: true } };
        await writeFile(path.join(appdata, "copilot-desktop-pet", "pet.json"), JSON.stringify(updated));
        for (const instance of [first, second]) {
            assert.equal((await instance.request("GET", "/pet.json")).json.name, updated.name);
            assert.equal((await instance.request("GET", "/api/state")).json.lookAtCopilot, true);
        }
    } finally { if (second) await second.stop(); await sb.cleanup(); }
});

test("1. GET /api/state：初始 idle，字段齐全", async (t) => {
    const ext = await boot(t, {});
    const r = await ext.request("GET", "/api/state");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    const s = r.json;
    assert.equal(s.activity, "idle");
    assert.equal(s.animation, null);
    assert.equal(s.message, null);
    assert.equal(s.crashed, false);
    assert.equal(s.running, false);
    assert.equal(s.pollIntervalMs, 250);
    assert.deepEqual(s.externalEvents, { enabled: false, port: 0 });
    assert.equal(s.pid, ext.child.pid);
    assert.ok(["self", "registry", "events-log", "explicit-idle", "none"].includes(s.activitySource),
        "activitySource 必须是契约枚举之一，实际=" + s.activitySource);
    assert.ok(Number.isInteger(s.sessions) && s.sessions >= 1);
});

test("2. POST /api/working → working；POST /api/idle → idle（source 正确）", async (t) => {
    const ext = await boot(t, { pet: withExternal(BASE_PET) });

    const w = await ext.request("POST", "/api/working", { body: {} });
    assert.equal(w.status, 200);
    assert.deepEqual(w.json, { ok: true, activity: "working", source: "external" });
    const s1 = await ext.request("GET", "/api/state");
    assert.equal(s1.json.activity, "working");
    assert.equal(s1.json.activitySource, "self");

    const i = await ext.request("POST", "/api/idle", { body: {} });
    assert.equal(i.status, 200);
    assert.equal(i.json.ok, true);
    assert.equal(i.json.activity, "idle");
    const s2 = await ext.request("GET", "/api/state");
    assert.equal(s2.json.activity, "idle");
    // 明确空闲的信号来源必须可辨认：抑制窗口内一律标 explicit-idle
    assert.equal(s2.json.activitySource, "explicit-idle");
    assert.equal(s2.json.running, false);
});

test("3. externalEvents 未开启：POST /api/working|idle → 403 且不改状态", async (t) => {
    const ext = await boot(t, {});
    const w = await ext.request("POST", "/api/working", { body: {} });
    assert.equal(w.status, 403);
    assert.equal(w.json.ok, false);
    assert.match(w.json.error, /disabled/i);

    const i = await ext.request("POST", "/api/idle", { body: {} });
    assert.equal(i.status, 403);

    const s = await ext.request("GET", "/api/state");
    assert.equal(s.json.activity, "idle");
});

test("4. externalEvents + token：错误 token 401、正确 token 200（header/query/body）", async (t) => {
    const ext = await boot(t, { pet: withExternal(BASE_PET, { token: "secret" }) });
    const idle = () => ext.request("POST", "/api/idle", { body: { token: "secret" } });

    const noToken = await ext.request("POST", "/api/working", { body: {} });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.ok, false);
    assert.match(noToken.json.error, /token/i);

    const badHeader = await ext.request("POST", "/api/working", { body: {}, headers: { "X-Pet-Token": "nope" } });
    assert.equal(badHeader.status, 401);
    const badQuery = await ext.request("POST", "/api/working?token=nope", { body: {} });
    assert.equal(badQuery.status, 401);

    const okHeader = await ext.request("POST", "/api/working", { body: {}, headers: { "X-Pet-Token": "secret" } });
    assert.equal(okHeader.status, 200);
    assert.equal(okHeader.json.activity, "working");

    await idle();
    const okQuery = await ext.request("POST", "/api/working?token=secret", { body: {} });
    assert.equal(okQuery.status, 200);
    assert.equal(okQuery.json.activity, "working");

    await idle();
    const okBody = await ext.request("POST", "/api/working", { body: { token: "secret" } });
    assert.equal(okBody.status, 200);

    // 鉴权失败不能改变状态：先回到 idle，再用错 token，状态必须还是 idle
    await idle();
    const bad = await ext.request("POST", "/api/working", { body: { token: "wrong" } });
    assert.equal(bad.status, 401);
    const s = await ext.request("GET", "/api/state");
    assert.equal(s.json.activity, "idle");
});

test("5. POST /api/say：/api/state.message 立刻可见，durationSec 后消失", async (t) => {
    const ext = await boot(t, {});

    const bad = await ext.request("POST", "/api/say", { body: { durationSec: 5 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.error, /text/i);

    const ok = await ext.request("POST", "/api/say", { body: { text: "你好呀", durationSec: 1 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    const s = await ext.request("GET", "/api/state");
    assert.equal(s.json.message, "你好呀");

    // durationSec=1 -> 约 1 秒后不再可见
    await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json.message === null;
    }, { timeoutMs: 3000, intervalMs: 100, label: "消息过期" });
});

test("6. POST /api/animation：合法动画 200、非法 400、auto 恢复自动", async (t) => {
    const ext = await boot(t, {});

    const ok = await ext.request("POST", "/api/animation", { body: { animation: "walk" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, animation: "walk" });
    assert.equal((await ext.request("GET", "/api/state")).json.animation, "walk");

    const bad = await ext.request("POST", "/api/animation", { body: { animation: "nope" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.error, /nope/);
    assert.deepEqual(bad.json.available.sort(), ["idle", "sleep", "walk"]);

    const auto = await ext.request("POST", "/api/animation", { body: { animation: "auto" } });
    assert.equal(auto.status, 200);
    assert.deepEqual(auto.json, { ok: true, animation: null });
    assert.equal((await ext.request("GET", "/api/state")).json.animation, null);

    // 非法动画不能改变已有覆盖
    await ext.request("POST", "/api/animation", { body: { animation: "sleep" } });
    const bad2 = await ext.request("POST", "/api/animation", { body: { animation: "ghost" } });
    assert.equal(bad2.status, 400);
    assert.equal((await ext.request("GET", "/api/state")).json.animation, "sleep");
});

test("7. PET_SIMULATE_CRASH_MS=400：进程不退出，crashed=true + animation=failed，约 5s 后自愈且 HTTP 仍可用", async (t) => {
    const ext = await boot(t, { env: { PET_SIMULATE_CRASH_MS: "400" } });

    const crashed = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json && r.json.crashed ? r.json : null;
    }, { timeoutMs: 6000, intervalMs: 50, label: "crashed=true" });

    assert.equal(crashed.crashed, true);
    assert.equal(crashed.animation, "failed");
    assert.equal(typeof crashed.message, "string");
    assert.ok(crashed.message.length > 0, "崩溃时应有一句台词");
    assert.equal(ext.child.exitCode, null, "崩溃不能杀死进程");

    const recovered = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json && r.json.crashed === false ? r.json : null;
    }, { timeoutMs: 12000, intervalMs: 100, label: "crashed=false（自愈）" });
    assert.equal(recovered.crashed, false);

    // 自愈后 HTTP 仍然可用，且状态回到 idle（没有真实工作信号）
    const after = await ext.request("GET", "/api/state");
    assert.equal(after.status, 200);
    assert.equal(after.json.activity, "idle");
    assert.equal(after.json.animation, null);

    // 崩溃动画的清理：失败动画不应长期残留
    await sleep(1500);
    const still = await ext.request("GET", "/api/state");
    assert.equal(still.json.crashed, false);
    assert.notEqual(still.json.animation, "failed");
});

test("8. GET /api/events：SSE 首帧 + 状态变化即时推送", async (t) => {
    const ext = await boot(t, { pet: withExternal(BASE_PET) });

    const sse = await openSSE(ext.port);
    t.after(() => sse.close());
    assert.equal(sse.status, 200);
    assert.match(sse.contentType, /text\/event-stream/);

    const first = await sse.waitForEvent((e) => e.event === "state", 5000);
    assert.ok(first[0].parsed, "SSE data 必须是 JSON");
    assert.equal(first[0].parsed.activity, "idle");

    const before = sse.events.length;
    await ext.request("POST", "/api/working", { body: {} });
    const hits = await sse.waitForEvent((e) => e.event === "state" && e.parsed && e.parsed.activity === "working", 8000);
    assert.ok(sse.events.length > before, "推送后事件数应增加");
    assert.equal(hits[0].parsed.activity, "working");
    assert.equal(hits[0].parsed.activitySource, "self");
});
test("9. explicit-idle 抑制：events-log 兜底期间 POST /api/idle 后 7s 内保持 idle，窗口过后兜底恢复", async (t) => {
    const ext = await boot(t, { pet: withExternal(BASE_PET) });
    const eventsDir = path.join(ext.dir, "home", ".copilot", "session-state", "probe-session");
    await mkdir(eventsDir, { recursive: true });
    const eventsFile = path.join(eventsDir, "events.jsonl");
    const touch = async () => {
        await writeFile(eventsFile, JSON.stringify({ type: "probe", ts: Date.now() }) + "\n");
        await sleep(1200);   // 越过 anySessionActive 的 1s 缓存
    };

    // 1) 他方会话事件日志活跃 -> 兜底把桌宠拉成 working/events-log
    await touch();
    const fallback = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json.activity === "working" && r.json.activitySource === "events-log" ? r.json : null;
    }, { timeoutMs: 5000, intervalMs: 100, label: "events-log 兜底 working" });
    assert.equal(fallback.activity, "working");

    // 2) 明确空闲：立刻 idle，且抑制兜底
    const t0 = Date.now();
    const idle = await ext.request("POST", "/api/idle", { body: {} });
    assert.equal(idle.status, 200);
    const nowIdle = (await ext.request("GET", "/api/state")).json;
    assert.equal(nowIdle.activity, "idle");
    assert.equal(nowIdle.activitySource, "explicit-idle");

    // 3) 抑制窗口内，即使事件日志又被写活，也不能回到 working
    await touch();
    const held = (await ext.request("GET", "/api/state")).json;
    assert.equal(held.activity, "idle", "明确空闲 7s 内不应被 events-log 兜底拉回 working");
    assert.equal(held.activitySource, "explicit-idle");
    assert.ok(Date.now() - t0 < 7000, "第 3 步应仍在抑制窗口内");

    // 4) 抑制窗口过后，兜底重新生效
    const remain = Math.max(0, t0 + 7050 - Date.now());
    await sleep(remain);
    await touch();
    const resumed = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json.activity === "working" && r.json.activitySource === "events-log" ? r.json : null;
    }, { timeoutMs: 5000, intervalMs: 100, label: "抑制过期后恢复 events-log" });
    assert.equal(resumed.activity, "working");
    assert.ok(Date.now() - t0 >= 7000);
});

test("10. 契约补充端点：GET /、/pet.json、/api/sessions、POST /api/reload、404", async (t) => {
    const ext = await boot(t, { pet: withExternal(BASE_PET, { port: 0, token: "" }) });

    const home = await ext.request("GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.headers["content-type"], /text\/html/);
    assert.match(home.text, /<canvas id="pet">/, "GET / 必须返回 pet.html 本体");

    const cfg = await ext.request("GET", "/pet.json");
    assert.equal(cfg.status, 200);
    assert.equal(cfg.json.name, BASE_PET.name);
    assert.equal(cfg.json.pollIntervalMs, 250);
    assert.equal(cfg.json.externalEvents.enabled, true);
    // /pet.json 返回配置原文（port=0 表示「跟随主服务端口」，解析发生在 /api/state）
    assert.equal(cfg.json.externalEvents.port, 0);
    assert.equal(cfg.json._error, undefined);
    const resolved = await ext.request("GET", "/api/state");
    assert.equal(resolved.json.externalEvents.enabled, true);
    assert.equal(resolved.json.externalEvents.port, ext.port, "port=0 时 /api/state 应回填实际端口");

    const sessions = await ext.request("GET", "/api/sessions");
    assert.equal(sessions.status, 200);
    assert.ok(Array.isArray(sessions.json) && sessions.json.length >= 1);
    const self = sessions.json.find((s) => s.pid === ext.child.pid);
    assert.ok(self, "sessions 里应包含本实例");
    assert.equal(self.self, true);
    assert.equal(self.petPid, null);
    assert.equal(self.port, ext.port);
    assert.ok(Number.isInteger(self.ageSec) && self.ageSec >= 0);

    const reload = await ext.request("POST", "/api/reload", { body: {} });
    assert.equal(reload.status, 200);
    assert.equal(reload.json.ok, true);
    assert.deepEqual(reload.json.animations.sort(), ["idle", "sleep", "walk"]);

    const missing = await ext.request("GET", "/definitely-not-here");
    assert.equal(missing.status, 404);
});

test("11. 运行中热改 pet.json：/api/reload 与后续请求都能看到新配置", async (t) => {
    const ext = await boot(t, { pet: withExternal(BASE_PET, { token: "secret" }) });

    const beforeReload = await ext.request("POST", "/api/working", { body: { token: "secret" } });
    assert.equal(beforeReload.status, 200);

    const next = withExternal(BASE_PET, { token: "rotated" });
    next.pollIntervalMs = 900;
    next.animations = Object.assign({}, BASE_PET.animations, { dance: { row: 3, frames: 6 } });
    await writeFile(path.join(ext.dir, "home", "AppData", "Roaming", "copilot-desktop-pet", "pet.json"), JSON.stringify(next, null, 2));

    const reload = await ext.request("POST", "/api/reload", { body: {} });
    assert.equal(reload.json.ok, true);
    assert.deepEqual(reload.json.animations.sort(), ["dance", "idle", "sleep", "walk"]);

    const s = await ext.request("GET", "/api/state");
    assert.equal(s.json.pollIntervalMs, 900);

    // token 轮换后：旧 token 401、新 token 200
    const oldTok = await ext.request("POST", "/api/working", { body: { token: "secret" } });
    assert.equal(oldTok.status, 401);
    const newTok = await ext.request("POST", "/api/working", { body: { token: "rotated" } });
    assert.equal(newTok.status, 200);

    // 新动画可被使用
    const anim = await ext.request("POST", "/api/animation", { body: { animation: "dance" } });
    assert.equal(anim.status, 200);
    assert.equal((await ext.request("GET", "/api/state")).json.animation, "dance");
});

test("12. 导入与切换桌宠只写入 AppData，扩展目录体积不增长", async (t) => {
    const ext = await boot(t, {});
    const dataDir = path.join(ext.dir, "home", "AppData", "Roaming", "copilot-desktop-pet");
    const extensionBytes = async () => {
        let total = 0;
        const visit = async (dir) => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                if (entry.name === "node_modules" || entry.name === "home" || entry.name === "tmp") continue;
                const filename = path.join(dir, entry.name);
                if (entry.isDirectory()) await visit(filename);
                else total += (await stat(filename)).size;
            }
        };
        await visit(ext.dir);
        return total;
    };
    const before = await extensionBytes();
    const sprite = await readFile(path.join(ext.dir, "spritesheet.png"));
    const imported = await ext.request("POST", "/api/pets/import", { body: {
        config: BASE_PET,
        spriteName: "large.png",
        spriteData: sprite.toString("base64"),
    } });
    assert.equal(imported.status, 200, imported.text);
    assert.equal((await extensionBytes()), before);

    const listed = await ext.request("GET", "/api/pets");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.pets.length, 2, "导入的桌宠和内置 Octocat");
    assert.ok(listed.json.pets.some((pet) => pet.id === imported.json.pet.id));
    const petDir = path.join(dataDir, "pets", imported.json.pet.id);
    assert.equal(JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8")).sprite, "spritesheet.png");
    assert.equal((await ext.request("GET", "/pets/" + imported.json.pet.id + "/spritesheet.png")).status, 200);
    const activation = await ext.request("POST", "/api/pets/activate", { body: { id: imported.json.pet.id } });
    assert.equal(activation.json.ok, true);
    const activeConfig = JSON.parse(await readFile(path.join(dataDir, "pet.json"), "utf8"));
    assert.equal(activeConfig.sprite, path.join("pets", imported.json.pet.id, "spritesheet.png"));
    assert.equal((await ext.request("GET", "/" + activeConfig.sprite)).status, 200);
    assert.equal((await extensionBytes()), before);
});

test("13. 启动时将旧宠物库无覆盖迁移至 AppData", async (t) => {
    const legacySprite = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const legacyPet = { name: "旧宠物", sprite: "legacy.png", animations: BASE_PET.animations };
    const legacyId = "12345678-1234-4234-8234-123456789abc";
    const ext = await boot(t, {
        pet: legacyPet,
        extraFiles: {
            "legacy.png": legacySprite,
            [path.join("pets", "active.json")]: JSON.stringify({ id: legacyId }),
            [path.join("pets", legacyId, "pet.json")]: JSON.stringify(Object.assign({}, legacyPet, { sprite: "legacy.png" })),
            [path.join("pets", legacyId, "legacy.png")]: legacySprite,
        },
    });
    const dataDir = path.join(ext.dir, "home", "AppData", "Roaming", "copilot-desktop-pet");
    assert.deepEqual(await readFile(path.join(dataDir, "legacy.png")), legacySprite);
    assert.deepEqual(await readFile(path.join(dataDir, "pets", legacyId, "legacy.png")), legacySprite);
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "pets", "active.json"), "utf8")), { id: legacyId });
    assert.ok((await ext.request("GET", "/api/pets")).json.pets.some((pet) => pet.id === legacyId));
    assert.equal((await ext.request("GET", "/pets/" + legacyId + "/legacy.png")).status, 200);
    assert.equal((await ext.request("GET", "/legacy.png")).status, 200);
});

test("14. POST /api/look_at_copilot：显式开关、缺省取反、状态与 SSE 同步", async (t) => {
    const ext = await boot(t, {});

    assert.equal((await ext.request("GET", "/api/state")).json.lookAtCopilot, false, "默认不看对话框");

    const on = await ext.request("POST", "/api/look_at_copilot", { body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.deepEqual(on.json, { ok: true, lookAtCopilot: true });
    assert.equal((await ext.request("GET", "/api/state")).json.lookAtCopilot, true);

    const sse = await openSSE(ext.port);
    t.after(() => sse.close());
    await sse.waitForEvent((e) => e.event === "state", 5000);

    const off = await ext.request("POST", "/api/look_at_copilot", { body: { enabled: false } });
    assert.deepEqual(off.json, { ok: true, lookAtCopilot: false });
    const pushed = await sse.waitForEvent((e) => e.event === "state" && e.parsed && e.parsed.lookAtCopilot === false, 8000);
    assert.equal(pushed[0].parsed.lookAtCopilot, false);

    // 缺省 enabled 即取反（右键菜单的「开/关」一键切换）
    const toggled = await ext.request("POST", "/api/look_at_copilot", { body: {} });
    assert.deepEqual(toggled.json, { ok: true, lookAtCopilot: true });
    const again = await ext.request("POST", "/api/look_at_copilot", { body: {} });
    assert.deepEqual(again.json, { ok: true, lookAtCopilot: false });

    const bad = await ext.request("POST", "/api/look_at_copilot", { body: "{" });
    assert.equal(bad.status, 400);
});

test("15. POST /api/chat：回复由桌宠说出来，提示词带人设且不改文件", async (t) => {
    const ext = await boot(t, { env: { PET_TEST_CHAT_REPLY: "我在的，今天想聊点什么？" } });

    const empty = await ext.request("POST", "/api/chat", { body: { text: "   " } });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.ok, false);
    assert.match(empty.json.error, /text/i);

    const tooLong = await ext.request("POST", "/api/chat", { body: { text: "啊".repeat(2001) } });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /太长/);

    const ok = await ext.request("POST", "/api/chat", { body: { text: "你在干嘛？" } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.reply, "我在的，今天想聊点什么？");
    assert.equal((await ext.request("GET", "/api/state")).json.message, "我在的，今天想聊点什么？");

    // message 字段是 text 的别名，桌面窗和画布都能用
    const alias = await ext.request("POST", "/api/chat", { body: { message: "再问一次" } });
    assert.equal(alias.status, 200);

    const log = await readChatLog(ext.dir);
    assert.equal(log.length, 2);
    const prompt = log[0].options.prompt;
    assert.ok(prompt.includes("你在干嘛？"), "提示词必须带上用户原话");
    assert.ok(prompt.includes("测试桌宠"), "提示词应带上桌宠名字");
    assert.match(prompt, /不要调用任何工具/, "必须禁止聊天时动工具");
    assert.match(prompt, /不要修改文件/, "必须禁止聊天时改文件");
    assert.equal(typeof log[0].timeout, "number");
    assert.ok(log[0].timeout > 0, "应把 chat.timeoutMs 传给 sendAndWait");
});

test("16. 聊天异常路径：超长回复截断、空回复 504、抛错 504 都回退到离线台词", async (t) => {
    const offline = { chat: { offlineReplies: ["我现在连不上大脑，等下再聊～"], timeoutMs: 2000 } };

    const long = await boot(t, { pet: Object.assign({}, BASE_PET, { chat: { maxChars: 2000 } }), env: { PET_TEST_CHAT_REPLY: "字".repeat(400) } });
    const r1 = await long.request("POST", "/api/chat", { body: { text: "说长一点" } });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.reply.length, 400, "接口返回完整回复");
    const bubble = (await long.request("GET", "/api/state")).json.message;
    assert.ok(bubble.length <= 161, "气泡必须截断，实际长度=" + bubble.length);
    assert.ok(bubble.endsWith("…"));

    const empty = await boot(t, { pet: Object.assign({}, BASE_PET, offline), env: { PET_TEST_CHAT_REPLY: "__EMPTY__" } });
    const r2 = await empty.request("POST", "/api/chat", { body: { text: "在吗" } });
    assert.equal(r2.status, 504);
    assert.equal(r2.json.ok, false);
    assert.equal(r2.json.reply, "我现在连不上大脑，等下再聊～");
    assert.equal((await empty.request("GET", "/api/state")).json.message, "我现在连不上大脑，等下再聊～");

    const boom = await boot(t, { pet: Object.assign({}, BASE_PET, offline), env: { PET_TEST_CHAT_THROW: "会话已经关了" } });
    const r3 = await boom.request("POST", "/api/chat", { body: { text: "在吗" } });
    assert.equal(r3.status, 504);
    assert.match(r3.json.error, /会话已经关了/);
    assert.equal((await boom.request("GET", "/api/state")).json.message, "我现在连不上大脑，等下再聊～");
});

test("17. 聊天并发：上一条还在想时第二条返回 429", async (t) => {
    const ext = await boot(t, { env: { PET_TEST_CHAT_DELAY_MS: "900" } });
    const first = ext.request("POST", "/api/chat", { body: { text: "第一个问题" } });
    await sleep(200);
    const second = await ext.request("POST", "/api/chat", { body: { text: "第二个问题" } });
    assert.equal(second.status, 429);
    assert.equal(second.json.ok, false);
    const done = await first;
    assert.equal(done.status, 200);

    // 忙完后可以继续聊
    const third = await ext.request("POST", "/api/chat", { body: { text: "第三个问题" } });
    assert.equal(third.status, 200);
});

test("18. 会话事件 → workPhase：思考中/跑工具分开，idle 与 error 都清空", async (t) => {
    const ext = await boot(t, {});

    await emitSessionEvent(ext.dir, "assistant.reasoning", {});
    const thinking = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json.activity === "working" && r.json.workPhase === "thinking" ? r.json : null;
    }, { timeoutMs: 6000, intervalMs: 50, label: "working/thinking" });
    assert.equal(thinking.workPhase, "thinking");

    await emitSessionEvent(ext.dir, "tool.execution_start", {});
    const tool = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json.workPhase === "tool" ? r.json : null;
    }, { timeoutMs: 6000, intervalMs: 50, label: "workPhase=tool" });
    assert.equal(tool.activity, "working");

    await emitSessionEvent(ext.dir, "session.idle", { aborted: false });
    const idle = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json.activity === "idle" ? r.json : null;
    }, { timeoutMs: 6000, intervalMs: 50, label: "idle 清空 workPhase" });
    assert.equal(idle.workPhase, null);

    // 异常结束：同样立刻回到 idle，且不残留 workPhase
    await emitSessionEvent(ext.dir, "assistant.turn_start", {});
    await waitFor(async () => (await ext.request("GET", "/api/state")).json.activity === "working",
        { timeoutMs: 6000, intervalMs: 50, label: "重新 working" });
    await emitSessionEvent(ext.dir, "session.error", {});
    const errored = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json.activity === "idle" ? r.json : null;
    }, { timeoutMs: 6000, intervalMs: 50, label: "session.error → idle" });
    assert.equal(errored.workPhase, null);
});

test("19. 特殊动画别名：崩溃演配置里的 error 动画（thinking/chat/look 等别名同理）", async (t) => {
    const pet = Object.assign({}, BASE_PET, {
        animations: Object.assign({}, BASE_PET.animations, {
            error: { row: 3, frames: 2 },
            thinking: { row: 4, frames: 2 },
            chat: { row: 5, frames: 2 },
            look: { row: 6, frames: 2 },
        }),
    });
    const ext = await boot(t, { pet: pet, env: { PET_SIMULATE_CRASH_MS: "400" } });

    const crashed = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json && r.json.crashed ? r.json : null;
    }, { timeoutMs: 6000, intervalMs: 50, label: "crashed=true" });
    assert.equal(crashed.animation, "error", "有 error 动画时不该再回退到 failed");

    // 崩溃的动画不能赖着不走
    const recovered = await waitFor(async () => {
        const r = await ext.request("GET", "/api/state");
        return r.json.crashed === false && r.json.animation === null ? r.json : null;
    }, { timeoutMs: 12000, intervalMs: 100, label: "自愈并清空动画" });
    assert.equal(recovered.crashed, false);

    // 别名解析是配置驱动的：删掉 error 后崩溃回退到 failed
    const fallbackPet = Object.assign({}, BASE_PET, {
        animations: Object.assign({}, BASE_PET.animations, { failed: { row: 3, frames: 2 } }),
    });
    const ext2 = await boot(t, { pet: fallbackPet, env: { PET_SIMULATE_CRASH_MS: "400" } });
    const crashed2 = await waitFor(async () => {
        const r = await ext2.request("GET", "/api/state");
        return r.json && r.json.crashed ? r.json : null;
    }, { timeoutMs: 6000, intervalMs: 50, label: "crashed=true (failed 别名)" });
    assert.equal(crashed2.animation, "failed");
});
test("20. POST /api/open_folder：打开桌宠库文件夹（固定路径，不接受外部输入）", async (t) => {
    const ext = await boot(t, {});
    const r = await ext.request("POST", "/api/open_folder", { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(path.isAbsolute(r.json.path), "返回绝对路径");
    assert.equal(path.basename(r.json.path), "pets");
    assert.ok(r.json.path.includes("copilot-desktop-pet"), "路径固定在数据目录下");
    assert.equal((await stat(r.json.path)).isDirectory(), true, "目录不存在时会先建出来");

    // 路径不可由请求体左右：塞什么都不影响结果
    const r2 = await ext.request("POST", "/api/open_folder", { body: { path: "C:\\Windows" } });
    assert.equal(r2.json.path, r.json.path);
});
