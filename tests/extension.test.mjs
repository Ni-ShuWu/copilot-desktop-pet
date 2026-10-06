// tests/extension.test.mjs —— 集成测试（零依赖）
// 每个用例：仓库文件复制到临时目录 + SDK stub + pet.json + 空闲端口 + spawn extension.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { makeSandbox, startExtension, freePort, openSSE, waitFor, sleep } from "./helpers.mjs";

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

/** 起一个隔离沙箱 + 扩展进程；用例结束后自动清理进程与临时目录 */
async function boot(t, opts) {
    const o = opts || {};
    const sb = await makeSandbox({ petJson: o.pet === undefined ? BASE_PET : o.pet });
    const port = await freePort();
    let ext;
    try {
        ext = await startExtension({
            dir: sb.dir,
            env: Object.assign({ PET_HTTP_PORT: String(port) }, o.env || {}),
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
    await writeFile(path.join(ext.dir, "pet.json"), JSON.stringify(next, null, 2));

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