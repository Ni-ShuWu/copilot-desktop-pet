// tests/state.test.mjs —— state.mjs 纯函数单测（零依赖：node:test + node:assert）
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_CONFIG, EXPLICIT_IDLE_SUPPRESS_MS, WORK_EVENTS, DONE_PHRASES, CRASH_PHRASES,
    clampPollMs, mergeConfig, createPetState, markWorking, markIdle, sanitizeActivity,
    computeActivity, say, visibleMessage, setAnimation, pickPhrase,
} from "../state.mjs";

test("clampPollMs: 默认值 / 上下界 / 非法值", () => {
    // 契约 §6：默认 250，clamp 100..5000
    assert.equal(clampPollMs(undefined, DEFAULT_CONFIG.pollIntervalMs), 250);
    assert.equal(clampPollMs(250, 250), 250);
    assert.equal(clampPollMs(1, 250), 100);        // 小于下界 -> 100
    assert.equal(clampPollMs(0, 250), 250);        // 0 -> fallback
    assert.equal(clampPollMs(-5, 250), 250);       // 负数 -> fallback
    assert.equal(clampPollMs(999999, 250), 5000);  // 大于上界 -> 5000
    assert.equal(clampPollMs(120.6, 250), 121);    // 四舍五入
    assert.equal(clampPollMs("300", 250), 300);    // 数字字符串
    assert.equal(clampPollMs("abc", 250), 250);    // 非数字 -> fallback
    assert.equal(clampPollMs(NaN, 250), 250);
    assert.equal(clampPollMs(Infinity, 250), 250);
    // 边界本身不被裁剪
    assert.equal(clampPollMs(100, 250), 100);
    assert.equal(clampPollMs(5000, 250), 5000);
});

test("mergeConfig: 缺省 / 部分覆盖 / 嵌套补齐 / 空值兜底", () => {
    assert.deepEqual(mergeConfig(), DEFAULT_CONFIG);
    assert.deepEqual(mergeConfig(null), DEFAULT_CONFIG);

    const cfg = mergeConfig({ pollIntervalMs: 500, externalEvents: { enabled: true, token: "secret" } });
    assert.equal(cfg.pollIntervalMs, 500);
    assert.equal(cfg.externalEvents.enabled, true);
    assert.equal(cfg.externalEvents.token, "secret");
    // 未写的嵌套字段补默认值
    assert.equal(cfg.externalEvents.port, 0);
    // 契约 §2 已删除 behavior.orphanGraceSec（代码从未实现），此处不再断言该字段
    assert.equal(cfg.behavior.autoWander, true);
    assert.equal(cfg.speech.fontSize, 13);
    assert.deepEqual(cfg.animations, DEFAULT_CONFIG.animations);

    // behavior 部分覆盖时，其余字段仍是默认值
    const cfg2 = mergeConfig({ behavior: { walkSpeedPxPerSec: 80 } });
    assert.equal(cfg2.behavior.walkSpeedPxPerSec, 80);
    assert.deepEqual(cfg2.behavior.wanderIntervalSec, [3, 8]);
    assert.equal(cfg2.behavior.sleepAfterIdleSec, 45);

    // 不能污染 DEFAULT_CONFIG
    cfg2.behavior.walkSpeedPxPerSec = 999;
    assert.equal(DEFAULT_CONFIG.behavior.walkSpeedPxPerSec, 40);
});

test("computeActivity: 本会话 working 优先于一切", () => {
    const st = createPetState(1000);
    markWorking(st, 1000);
    // 即使显式空闲抑制还没过期、registry 也有 working，self 仍然优先
    st.explicitIdleUntil = 2000;
    assert.deepEqual(
        computeActivity({ state: st, entries: [{ activity: "working" }], now: 1500, fallbackActive: true }),
        { activity: "working", source: "self" },
    );
});

test("computeActivity: registry 分支（其他会话心跳）", () => {
    const st = createPetState(1000);
    const r = computeActivity({ state: st, entries: [{ activity: "working" }], now: 1500, fallbackActive: false });
    assert.deepEqual(r, { activity: "working", source: "registry" });

    // 注册表里都是 idle：有条目 -> registry，没有条目 -> none
    assert.deepEqual(
        computeActivity({ state: st, entries: [{ activity: "idle" }], now: 1500, fallbackActive: false }),
        { activity: "idle", source: "registry" },
    );
    assert.deepEqual(
        computeActivity({ state: st, entries: [], now: 1500, fallbackActive: false }),
        { activity: "idle", source: "none" },
    );
    // id 字段容错：entries 里混入 null 不应抛错
    assert.deepEqual(
        computeActivity({ state: st, entries: [null, { activity: "working" }], now: 1500, fallbackActive: false }),
        { activity: "working", source: "registry" },
    );
});

test("computeActivity: explicit-idle 抑制（markIdle 后 7s 内忽略 events-log 兜底）", () => {
    const st = createPetState(1000);
    markWorking(st, 1000);
    markIdle(st, 1000, { suppressMs: EXPLICIT_IDLE_SUPPRESS_MS });
    assert.equal(st.explicitIdleUntil, 1000 + EXPLICIT_IDLE_SUPPRESS_MS);

    // 抑制窗口内：即使兜底认为活跃，也强制 idle
    assert.deepEqual(
        computeActivity({ state: st, entries: [], now: 1500, fallbackActive: true }),
        { activity: "idle", source: "explicit-idle" },
    );
    // 边界：刚好到截止时间就不再生效
    assert.deepEqual(
        computeActivity({ state: st, entries: [], now: 1000 + EXPLICIT_IDLE_SUPPRESS_MS, fallbackActive: true }),
        { activity: "working", source: "events-log" },
    );
    // 抑制窗口内即使兜底不活跃、registry 有条目，来源也必须标成 explicit-idle
    assert.deepEqual(
        computeActivity({ state: st, entries: [{ activity: "idle" }], now: 1500, fallbackActive: false }),
        { activity: "idle", source: "explicit-idle" },
    );
    // 窗口过后：兜底生效
    assert.deepEqual(
        computeActivity({ state: st, entries: [], now: 1000 + EXPLICIT_IDLE_SUPPRESS_MS + 1, fallbackActive: true }),
        { activity: "working", source: "events-log" },
    );
});

test("computeActivity: events-log 兜底与全空闲", () => {
    const st = createPetState(1000);
    assert.deepEqual(
        computeActivity({ state: st, entries: [], now: 1500, fallbackActive: true }),
        { activity: "working", source: "events-log" },
    );
    assert.deepEqual(
        computeActivity({ state: st, entries: [], now: 1500, fallbackActive: false }),
        { activity: "idle", source: "none" },
    );
});

test("markWorking / markIdle: 返回 wasWorking 并清掉 crash 标记", () => {
    const st = createPetState(0);
    assert.equal(st.activity, "idle");
    assert.equal(st.crashed, false);

    markWorking(st, 100);
    assert.equal(st.activity, "working");
    assert.equal(st.activityAt, 100);

    const r = markIdle(st, 200, { suppressMs: 100 });
    assert.equal(r.wasWorking, true);
    assert.equal(st.activity, "idle");
    assert.equal(st.explicitIdleUntil, 300);
    // 已经是 idle 时再次 markIdle，wasWorking=false；带 suppressMs 时抑制窗口从新的 now 重新计算
    const r2 = markIdle(st, 400, { suppressMs: 100 });
    assert.equal(r2.wasWorking, false);
    assert.equal(st.explicitIdleUntil, 500);
    // 不带 suppressMs 时不设抑制窗口
    const st2 = createPetState(0);
    markIdle(st2, 10, undefined);
    assert.equal(st2.explicitIdleUntil, 0);

    st.crashed = true;
    markWorking(st, 500);
    assert.equal(st.crashed, false);
});

test("sanitizeActivity: 别名与非法值", () => {
    assert.equal(sanitizeActivity("working"), "working");
    assert.equal(sanitizeActivity("  WORKING  "), "working");
    assert.equal(sanitizeActivity("busy"), "working");
    assert.equal(sanitizeActivity("work"), "working");
    assert.equal(sanitizeActivity("idle"), "idle");
    assert.equal(sanitizeActivity("done"), "idle");
    assert.equal(sanitizeActivity("stop"), "idle");
    assert.equal(sanitizeActivity("stopped"), "idle");
    assert.equal(sanitizeActivity("sleeping"), null);
    assert.equal(sanitizeActivity(""), null);
    assert.equal(sanitizeActivity(123), null);
    assert.equal(sanitizeActivity(null), null);
    assert.equal(sanitizeActivity(undefined), null);
});

test("say / visibleMessage: 时长与过期", () => {
    const st = createPetState(0);
    assert.equal(visibleMessage(st, 0), null);

    assert.deepEqual(say(st, "你好", 2, 1000), { ok: true });
    assert.equal(st.message, "你好");
    assert.equal(st.messageUntil, 3000);
    assert.equal(visibleMessage(st, 1000), "你好");
    assert.equal(visibleMessage(st, 2999), "你好");
    assert.equal(visibleMessage(st, 3000), null);   // 到期即不可见

    // durationSec 兜底：0 / 非法 -> 4 秒，负数 -> 1 秒
    say(st, "x", 0, 0);
    assert.equal(st.messageUntil, 4000);
    say(st, "x", "abc", 0);
    assert.equal(st.messageUntil, 4000);
    say(st, "x", -3, 0);
    assert.equal(st.messageUntil, 1000);

    // null 文本转成空串（而不是 "null"）
    say(st, null, 1, 0);
    assert.equal(st.message, "");
    assert.equal(visibleMessage(st, 0), null);      // 空串视为无消息
});

test("setAnimation: auto/空值 -> null；合法 -> 设置；非法 -> 报错并列出可用动画", () => {
    const config = mergeConfig({});
    const st = createPetState(0);

    assert.deepEqual(setAnimation(st, "idle", config), { ok: true, animation: "idle" });
    assert.equal(st.animation, "idle");
    for (const v of [null, undefined, "", "auto"]) {
        assert.deepEqual(setAnimation(st, v, config), { ok: true, animation: null });
        assert.equal(st.animation, null);
    }

    const bad = setAnimation(st, "nope", config);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /nope/);
    assert.deepEqual(bad.available, Object.keys(config.animations));
    assert.equal(st.animation, null);               // 失败不改变状态

    // 自定义 animations 生效
    const cfg2 = mergeConfig({ animations: { idle: { row: 0, frames: 4 }, walk: { row: 1, frames: 4 } } });
    assert.deepEqual(setAnimation(st, "walk", cfg2), { ok: true, animation: "walk" });
    assert.equal(st.animation, "walk");
    // 缺少 animations 的 config 不应抛错
    assert.equal(setAnimation(st, "idle", {}).ok, false);
});

test("pickPhrase: 走随机函数且在列表内", () => {
    assert.equal(pickPhrase(["a", "b"], () => 0), "a");
    assert.equal(pickPhrase(["a", "b"], () => 0.999), "b");
    assert.ok(WORK_EVENTS.includes("user.message"));
    assert.ok(DONE_PHRASES.length > 0 && CRASH_PHRASES.length > 0);
});