// tests/state.test.mjs —— state.mjs 纯函数单测（零依赖：node:test + node:assert）
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_CONFIG, EXPLICIT_IDLE_SUPPRESS_MS, WORK_EVENTS, DONE_PHRASES, CRASH_PHRASES, ABORT_PHRASES,
    ERROR_PHRASES, ANIM_ALIASES, BUBBLE_TEXT_MAX,
    clampPollMs, mergeConfig, createPetState, markWorking, markIdle, sanitizeActivity,
    computeActivity, say, visibleMessage, setAnimation, pickPhrase,
    setLookAtMouse, setWorkPhase, resolveAnimAlias, buildChatPrompt, truncateForBubble, normalizeChatText,
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
    // 主动结束与异常结束必须各有一套台词（两种收场不能看起来一样）
    assert.ok(ABORT_PHRASES.length > 0 && ERROR_PHRASES.length > 0);
    assert.ok(ABORT_PHRASES.every((p) => !ERROR_PHRASES.includes(p)));
});

test("setLookAtMouse: 显式开关与缺省取反", () => {
    const st = createPetState(0);
    assert.equal(st.lookAtMouse, false);
    assert.deepEqual(setLookAtMouse(st, true), { ok: true, lookAtMouse: true });
    assert.deepEqual(setLookAtMouse(st, true), { ok: true, lookAtMouse: true });
    assert.deepEqual(setLookAtMouse(st, false), { ok: true, lookAtMouse: false });
    // 右键菜单的「开/关」：不传参数即取反
    assert.deepEqual(setLookAtMouse(st, undefined), { ok: true, lookAtMouse: true });
    assert.deepEqual(setLookAtMouse(st, null), { ok: true, lookAtMouse: false });
    // 真值/假值都收敛成布尔
    assert.deepEqual(setLookAtMouse(st, 1), { ok: true, lookAtMouse: true });
    assert.deepEqual(setLookAtMouse(st, 0), { ok: true, lookAtMouse: false });
    assert.deepEqual(setLookAtMouse(st, "yes"), { ok: true, lookAtMouse: true });
});

test("setWorkPhase: 只接受 thinking/tool，其余清空", () => {
    const st = createPetState(0);
    assert.equal(st.workPhase, null);
    assert.equal(setWorkPhase(st, "thinking"), "thinking");
    assert.equal(setWorkPhase(st, "tool"), "tool");
    assert.equal(setWorkPhase(st, undefined), null);
    assert.equal(setWorkPhase(st, "idle"), null);
    assert.equal(setWorkPhase(st, "TOOL"), null);
    // markIdle 必须清掉阶段，避免 idle 后还演思考中
    setWorkPhase(st, "thinking");
    markIdle(st, 10, {});
    assert.equal(st.workPhase, null);
});

test("resolveAnimAlias: 按别名顺序取第一个存在的动画", () => {
    const cfg = mergeConfig({ animations: { work: { row: 1, frames: 4 }, chat: { row: 2, frames: 4 } } });
    assert.equal(resolveAnimAlias("tool", cfg), "work");
    assert.equal(resolveAnimAlias("chat", cfg), "chat");
    assert.equal(resolveAnimAlias("thinking", cfg), null, "没有 thinking/think/reasoning 时返回 null");
    assert.equal(resolveAnimAlias("error", cfg), null);
    assert.equal(resolveAnimAlias("unknown-kind", cfg), null);

    // 首选名不存在时按顺序回退
    const cfg2 = mergeConfig({ animations: { think: { row: 0, frames: 4 }, grab: { row: 1, frames: 4 } } });
    assert.equal(resolveAnimAlias("thinking", cfg2), "think");
    assert.equal(resolveAnimAlias("drag", cfg2), "grab");
    // 容错：config 缺失不抛错
    assert.equal(resolveAnimAlias("walk", null), null);
    assert.equal(resolveAnimAlias("walk", {}), null);
    assert.ok(ANIM_ALIASES.error.includes("failed"), "崩溃动画的别名必须包含 failed");
});

test("buildChatPrompt: 人设 + 用户原话，{name} 替换", () => {
    const cfg = mergeConfig({ name: "小包子" });
    const p = buildChatPrompt("今天天气怎么样？", cfg);
    assert.ok(p.includes("小包子"), "人设里的 {name} 要替换成桌宠名");
    assert.ok(!p.includes("{name}"));
    assert.ok(p.includes("今天天气怎么样？"));
    assert.match(p, /不要调用任何工具/, "聊天不该让 agent 动工具");

    // 自定义人设优先
    const cfg2 = mergeConfig({ chat: { persona: "你是{name}，只回一个字。" } });
    assert.equal(buildChatPrompt("喂", cfg2), "你是Copilot 桌宠，只回一个字。\n\n用户说：喂");
    // 空文本 / null 不炸
    assert.ok(buildChatPrompt(null, cfg2).endsWith("用户说："));
});

test("truncateForBubble: 压缩空白与超长截断", () => {
    assert.equal(truncateForBubble("  你好   世界 ", 100), "你好 世界");
    assert.equal(truncateForBubble("", 100), "");
    assert.equal(truncateForBubble(null, 100), "");
    const long = "字".repeat(300);
    const cut = truncateForBubble(long);
    assert.equal(cut.length, BUBBLE_TEXT_MAX);
    assert.ok(cut.endsWith("…"));
    assert.equal(truncateForBubble(long, 10).length, 10);
    assert.equal(truncateForBubble("12345", 5), "12345");
    // 非法上限回退默认值
    assert.equal(truncateForBubble(long, 0).length, BUBBLE_TEXT_MAX);
    assert.equal(truncateForBubble(long, "abc").length, BUBBLE_TEXT_MAX);
});

test("normalizeChatText: 空/超长拒绝，正常输入 trim", () => {
    const cfg = mergeConfig({});
    assert.deepEqual(normalizeChatText("  你好  ", cfg), { ok: true, text: "你好" });
    assert.equal(normalizeChatText("", cfg).ok, false);
    assert.equal(normalizeChatText("   ", cfg).ok, false);
    assert.equal(normalizeChatText(null, cfg).ok, false);
    assert.equal(normalizeChatText(undefined, cfg).ok, false);
    assert.match(normalizeChatText(null, cfg).error, /text/i);

    const over = "a".repeat(DEFAULT_CONFIG.chat.maxChars + 1);
    const bad = normalizeChatText(over, cfg);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /太长/);
    assert.equal(normalizeChatText("a".repeat(DEFAULT_CONFIG.chat.maxChars), cfg).ok, true);

    // 自定义上限
    assert.equal(normalizeChatText("abcdef", mergeConfig({ chat: { maxChars: 5 } })).ok, false);
    assert.equal(normalizeChatText("abcde", mergeConfig({ chat: { maxChars: 5 } })).ok, true);
});

test("mergeConfig: chat 块与 behavior.lookAtMouse 补齐", () => {
    const cfg = mergeConfig({ chat: { maxChars: 500, offlineReplies: ["稍后再聊"] } });
    assert.equal(cfg.chat.maxChars, 500);
    assert.deepEqual(cfg.chat.offlineReplies, ["稍后再聊"]);
    assert.equal(cfg.chat.persona, DEFAULT_CONFIG.chat.persona);
    assert.equal(cfg.chat.timeoutMs, DEFAULT_CONFIG.chat.timeoutMs);
    assert.equal(cfg.behavior.lookAtMouse, false);
    assert.equal(mergeConfig({ behavior: { lookAtMouse: true } }).behavior.lookAtMouse, true);
    // 不污染默认值
    cfg.chat.maxChars = 99999;
    assert.equal(DEFAULT_CONFIG.chat.maxChars, 2000);
});