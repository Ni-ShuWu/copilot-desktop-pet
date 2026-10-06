// 桌宠状态机（纯逻辑：无 IO、无副作用，便于单元测试）
// extension.mjs 与本地 HTTP 服务共用：
//   - agent 会话事件、HTTP 外部推送，全部收敛到 markWorking / markIdle
//   - computeActivity 把「本会话状态 + 其他会话心跳 + 事件日志兜底」合成为最终展示状态

export const DEFAULT_CONFIG = {
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
    pollIntervalMs: 250,
    // 外部事件监听：默认关闭。开启后可通过本机 HTTP 直接推送 working / idle，
    // 这样不装 Copilot 扩展（例如只用 PowerShell 启动）也能让桌宠联动。
    externalEvents: { enabled: false, port: 0, token: "" },
};

// 「明确空闲」信号之后的兜底抑制窗口：
// 收到 session.idle（或 POST /api/idle）说明本会话确实收工了，
// 但 events.jsonl 可能仍被后台补写，此时不能再让兜底逻辑把桌宠拉回 working。
export const EXPLICIT_IDLE_SUPPRESS_MS = 7000;

export const WORK_EVENTS = [
    "user.message", "assistant.turn_start", "assistant.message",
    "assistant.reasoning", "tool.execution_start", "tool.execution_complete",
];

export const DONE_PHRASES = ["做完了。", "任务完成，去看看吧。", "嗯，都处理好了。", "收工。"];
export const CRASH_PHRASES = ["哎呀，我摔了一跤……", "出了点状况，正在重启。", "别慌，我马上回来。"];

const POLL_MIN_MS = 100;
const POLL_MAX_MS = 5000;

export function clampPollMs(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(n)));
}

// 浅合并 + 嵌套字段补齐：pet.json 只写一部分时也要拿到完整默认值
export function mergeConfig(parsed) {
    const src = parsed || {};
    const cfg = Object.assign({}, DEFAULT_CONFIG, src);
    cfg.behavior = Object.assign({}, DEFAULT_CONFIG.behavior, src.behavior || {});
    cfg.speech = Object.assign({}, DEFAULT_CONFIG.speech, src.speech || {});
    cfg.externalEvents = Object.assign({}, DEFAULT_CONFIG.externalEvents, src.externalEvents || {});
    return cfg;
}

export function createPetState(now) {
    return {
        animation: null,      // 动画覆盖（null = 自动行为）
        message: null,
        messageUntil: 0,
        activity: "idle",     // idle | working
        activityAt: now || 0,
        explicitIdleUntil: 0, // 兜底抑制截止时间戳
        crashed: false,
    };
}

export function markWorking(state, now) {
    state.activity = "working";
    state.activityAt = now;
    state.crashed = false;
    return state;
}

// 返回 { wasWorking }：调用方据此决定要不要放「做完了」的复盘动画
export function markIdle(state, now, opts) {
    const wasWorking = state.activity === "working";
    state.activity = "idle";
    state.activityAt = now;
    state.crashed = false;
    const suppressMs = opts && Number(opts.suppressMs);
    if (Number.isFinite(suppressMs) && suppressMs > 0) state.explicitIdleUntil = now + suppressMs;
    return { wasWorking };
}

export function sanitizeActivity(value) {
    if (typeof value !== "string") return null;
    const v = value.trim().toLowerCase();
    if (v === "working" || v === "busy" || v === "work") return "working";
    if (v === "idle" || v === "done" || v === "stop" || v === "stopped") return "idle";
    return null;
}

// 合成最终状态；source 便于 /api/state 调试与测试断言
export function computeActivity(input) {
    const state = input.state;
    const entries = input.entries || [];
    const now = input.now;
    if (state.activity === "working") return { activity: "working", source: "self" };
    if (entries.some((e) => e && e.activity === "working")) return { activity: "working", source: "registry" };
    // 明确空闲的抑制窗口内：忽略事件日志兜底，并把来源标成 explicit-idle 便于排查
    if (now < state.explicitIdleUntil) return { activity: "idle", source: "explicit-idle" };
    if (input.fallbackActive) return { activity: "working", source: "events-log" };
    return { activity: "idle", source: entries.length ? "registry" : "none" };
}

export function say(state, text, durationSec, now) {
    state.message = String(text == null ? "" : text);
    const sec = Math.max(1, Number(durationSec) || 4);
    state.messageUntil = now + sec * 1000;
    return { ok: true };
}

export function visibleMessage(state, now) {
    return state.message && now < state.messageUntil ? state.message : null;
}

export function setAnimation(state, anim, config) {
    if (anim === null || anim === undefined || anim === "" || anim === "auto") {
        state.animation = null;
        return { ok: true, animation: null };
    }
    const animations = (config && config.animations) || {};
    if (!(anim in animations)) {
        return { ok: false, error: "unknown animation '" + anim + "'", available: Object.keys(animations) };
    }
    state.animation = anim;
    return { ok: true, animation: anim };
}

export function pickPhrase(list, random) {
    const rnd = typeof random === "function" ? random : Math.random;
    return list[Math.floor(rnd() * list.length)];
}
