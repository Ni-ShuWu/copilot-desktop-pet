// pet.html 面板走动逻辑：用最小 DOM 桩在 Node 里驱动真实脚本的 tick 循环。
// 没有可用的浏览器，所以这里直接执行 pet.html 里那份 <script>，
// 通过 canvas.style.left/top 与 ctx.scale(-1,1)（= 用向左动画）做黑盒断言。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TAU = Math.PI * 2;
const STAGE_W = 20000;
const STAGE_H = 4000;

const html = await readFile(path.join(REPO, "pet.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("pet.html 里找不到 <script> 块");
const PANEL_SCRIPT = scriptMatch[1];

function makeCtx() {
    return {
        ops: [],
        clearRect() {},
        save() {},
        restore() {},
        drawImage() { this.ops.push("draw"); },
        scale(x, y) { this.ops.push("scale:" + x + "," + y); },
    };
}

function makeElement(tag) {
    const el = {
        tagName: String(tag || "div").toUpperCase(),
        children: [],
        options: [],
        style: {},
        dataset: {},
        attributes: {},
        listeners: {},
        textContent: "",
        className: "",
        value: "",
        checked: false,
        hidden: false,
        disabled: false,
        files: null,
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            contains(c) { return this._set.has(c); },
            toggle(c, on) { if (on === undefined) on = !this._set.has(c); if (on) this._set.add(c); else this._set.delete(c); },
        },
        appendChild(child) { this.children.push(child); this.options.push(child); return child; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        focus() {},
        getContext() { return this._ctx || (this._ctx = makeCtx()); },
        getBoundingClientRect() { return { left: 0, top: 0, width: 64, height: 64 }; },
    };
    Object.defineProperty(el, "innerHTML", {
        get() { return this._innerHTML || ""; },
        set(v) { this._innerHTML = v; if (!v) { this.children.length = 0; this.options.length = 0; } },
    });
    return el;
}

/** 在 vm 里跑真实的 pet.html 脚本，返回驱动 tick / 读数用的句柄 */
async function createPanel(behaviorOverrides) {
    const cfg = {
        name: "panel-test", sprite: "s.png", frameWidth: 32, frameHeight: 32, scale: 2, fps: 8,
        defaultAnimation: "idle", pollIntervalMs: 250,
        animations: { idle: { row: 0, frames: 4 }, walk: { row: 1, frames: 4 }, sleep: { row: 2, frames: 4 } },
        behavior: Object.assign({
            autoWander: true, walkSpeedPxPerSec: 40,
            // 把决策间隔拉到 600s：样本之间不会被不相关的 decide 打断
            wanderIntervalSec: [600, 600], sleepAfterIdleSec: 0, lookAtCopilot: false,
        }, behaviorOverrides || {}),
        speech: { phrases: ["hi"], fontSize: 13 },
    };

    const elements = {};
    const ids = ["pet", "bubble", "err", "btnToggle", "status", "btnLibrary", "library", "petList",
        "libraryHint", "configFile", "spriteFile", "animSelect", "chkLook", "btnCloseLibrary",
        "btnAllPets", "btnOpenFolder", "btnSavePet"];
    for (const id of ids) elements[id] = makeElement(id === "pet" ? "canvas" : "div");
    elements.library.hidden = true;

    const canvas = elements.pet;
    const ctx = canvas.getContext();

    const document = {
        getElementById(id) { return elements[id] || (elements[id] = makeElement("div")); },
        createElement(tag) { return makeElement(tag); },
        addEventListener() {},
        body: makeElement("body"),
    };
    const win = { innerWidth: STAGE_W, innerHeight: STAGE_H, addEventListener() {}, confirm() { return false; } };

    class FakeImage {
        constructor() { this.complete = false; this.naturalWidth = 0; }
        set src(v) { this._src = v; this.complete = true; this.naturalWidth = 128; if (this.onload) this.onload(); }
        get src() { return this._src; }
    }

    const fetch = async (url) => ({ json: async () => (String(url).indexOf("/pet.json") >= 0 ? cfg : {}) });

    let rafCb = null;
    let ts = 0;
    let fakeNow = 1000000;
    const hostRandom = Math.random;
    const queue = [];
    const nextRandom = () => (queue.length ? queue.shift() : hostRandom());

    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args); }
        static now() { return fakeNow; }
    }

    const sandbox = {
        __nextRandom: nextRandom, document, window: win, Date: FakeDate, console,
        Image: FakeImage, fetch, navigator: {},
        requestAnimationFrame(cb) { rafCb = cb; return 1; },
        setInterval() { return 1; },
        clearInterval() {},
    };
    const context = vm.createContext(sandbox);
    vm.runInContext("Math.random = function () { return __nextRandom(); };", context);
    vm.runInContext(PANEL_SCRIPT, context, { filename: "pet.html" });

    // 等 loadConfig() 的 promise 链走完（fetch -> json -> applyConfig）
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    const api = {
        cfg,
        /** 推进一帧；dtMs 会被 tick 内部按 0.1s 封顶 */
        frame(dtMs = 16) {
            assert.ok(rafCb, "requestAnimationFrame 回调丢失");
            ctx.ops.length = 0;
            ts += dtMs;
            fakeNow += dtMs;
            const cb = rafCb;
            rafCb = null;
            cb(ts);
        },
        /** 只推进“墙上时钟”，用来越过 nextDecisionAt 触发 decide，而不产生位移 */
        jump(ms) { fakeNow += ms; },
        /** 下一帧 decide 的随机数消费顺序：区间、是否走、朝向（可选，省略则用真实随机） */
        arm(...values) { for (const v of values) queue.push(v); },
        pos() {
            const top = canvas.style.top;
            return {
                x: parseFloat(canvas.style.left),
                y: top === "" ? null : parseFloat(top),
                top,
                bottom: canvas.style.bottom,
                // ctx.scale(-1,1) == 用“向左”动画；否则用“向右”动画
                flipped: ctx.ops.indexOf("scale:-1,1") >= 0,
            };
        },
    };
    api.frame(16); // 首帧让 render 写出 style.left/top
    return api;
}

/** 触发一次 walk 决策，并返回当帧之后的坐标 */
function walkWith(panel, headingFraction) {
    if (headingFraction === undefined) panel.arm(0.0, 0.0);
    else panel.arm(0.0, 0.0, headingFraction);
    panel.jump(700000);
    panel.frame(16);
    return panel.pos();
}

test("pet.html 全向走动：上下与斜向都真的在动，动画仍复用左右两套", async () => {
    const panel = await createPanel({ omniWander: true });
    const start = panel.pos();
    assert.equal(start.top, "", "初始（未走动）应沿用底边定位");

    // 纯向上（heading = 3PI/2）：y 变小、x 不变
    const up0 = walkWith(panel, 0.75);
    for (let i = 0; i < 60; i++) panel.frame(16);
    const up1 = panel.pos();
    assert.ok(up1.top !== "", "走动后应改为 top 定位（纵向可移动）");
    assert.ok(up1.y < up0.y, "纯向上走时 y 必须减小");
    assert.ok(Math.abs(up1.x - up0.x) < 1e-6, "纯向上走时 x 不应变化");

    // 斜向右下（heading = PI/4）：x 与 y 同时变大
    const dr0 = walkWith(panel, 0.125);
    for (let i = 0; i < 20; i++) panel.frame(16);
    const dr1 = panel.pos();
    assert.ok(dr1.x > dr0.x && dr1.y > dr0.y, "右下斜向必须同时在两个轴上移动");
    assert.equal(dr1.flipped, false, "偏右的斜向应复用向右动画");

    // 斜向左下（heading = 3PI/4）：x 变小、y 变大，且复用向左动画
    const dl0 = walkWith(panel, 0.375);
    for (let i = 0; i < 20; i++) panel.frame(16);
    const dl1 = panel.pos();
    assert.ok(dl1.x < dl0.x && dl1.y > dl0.y, "左下斜向必须同时在两个轴上移动");
    assert.equal(dl1.flipped, true, "偏左的斜向应复用向左动画");

    // 斜向右上（heading = 7PI/4）：x 变大、y 变小
    const ur0 = walkWith(panel, 0.875);
    for (let i = 0; i < 20; i++) panel.frame(16);
    const ur1 = panel.pos();
    assert.ok(ur1.x > ur0.x && ur1.y < ur0.y, "右上斜向必须同时在两个轴上移动");
    assert.equal(ur1.flipped, false, "偏右的斜向应复用向右动画");

    // 纯向下（heading = PI/2）：水平分量恰为 0 -> 保持上一次朝向（向右），不抖动
    const down0 = walkWith(panel, 0.25);
    for (let i = 0; i < 10; i++) panel.frame(16);
    const down1 = panel.pos();
    assert.ok(down1.y > down0.y, "纯向下走时 y 必须增大");
    assert.equal(down1.flipped, false, "纯上下时应保持上一次朝向，避免动画抖动");
});

test("pet.html 全向走动：随机角度覆盖四个方向且斜向占多数", async () => {
    const panel = await createPanel({ omniWander: true });

    // 先把桌宠挪到舞台中间，避免采样时撞到边界干扰判定
    walkWith(panel, 0.75);                       // 向上
    for (let i = 0; i < 300; i++) panel.frame(100);
    walkWith(panel, 0.0);                        // 再向右
    for (let i = 0; i < 300; i++) panel.frame(100);

    const dirs = { right: 0, left: 0, up: 0, down: 0, diagonal: 0, flipped: 0, plain: 0 };
    const seenDx = new Set();
    let samples = 0;
    for (let i = 0; i < 200; i++) {
        panel.arm(0.0, 0.0);                     // 朝向用真实随机数
        panel.jump(700000);
        panel.frame(16);
        const a = panel.pos();
        panel.frame(16);
        const b = panel.pos();
        if (b.x <= 0 || b.y === null || b.y <= 0) continue;   // 撞边界就丢弃这一笔
        if (b.x >= STAGE_W - 64 || b.y >= STAGE_H - 64) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        samples++;
        if (dx > 0.05) dirs.right++;
        if (dx < -0.05) dirs.left++;
        if (dy > 0.05) dirs.down++;
        if (dy < -0.05) dirs.up++;
        if (Math.abs(dx) > 0.05 && Math.abs(dy) > 0.05) dirs.diagonal++;
        if (b.flipped) dirs.flipped++; else dirs.plain++;
        seenDx.add(Math.round(dx * 100));
    }

    assert.ok(samples > 150, "有效样本应足够多，实际 " + samples);
    assert.ok(dirs.right > 0 && dirs.left > 0, "随机角度必须同时出现向右与向左");
    assert.ok(dirs.up > 0 && dirs.down > 0, "随机角度必须同时出现向上与向下（不再只有水平）");
    assert.ok(dirs.diagonal > samples * 0.3, "斜向应占多数，实际 " + dirs.diagonal + "/" + samples);
    assert.ok(dirs.flipped > 0 && dirs.plain > 0, "向左与向右动画都应被用到");
    assert.ok(seenDx.size > 20, "水平分量应连续随机分布，而不是只有两个取值");
});

test("pet.html 全向走动：上下边界都能反射且不会卡住", async () => {
    const panel = await createPanel({ omniWander: true });

    // 向上撞顶
    walkWith(panel, 0.75);
    let hitTop = -1;
    for (let i = 0; i < 4000 && hitTop < 0; i++) {
        panel.frame(100);
        if (panel.pos().y === 0) hitTop = i;
    }
    assert.ok(hitTop >= 0, "持续向上走应最终顶到上边界");
    const atTop = panel.pos().y;
    for (let i = 0; i < 5; i++) panel.frame(100);
    assert.equal(atTop, 0, "上边界应把 y 夹在 0");
    assert.ok(panel.pos().y > 0, "撞上边界后应反弹向下，而不是卡在边缘");

    // 向下撞底
    walkWith(panel, 0.25);
    const maxY = STAGE_H - 64;
    let hitBottom = -1;
    for (let i = 0; i < 4000 && hitBottom < 0; i++) {
        panel.frame(100);
        if (panel.pos().y >= maxY) hitBottom = i;
    }
    assert.ok(hitBottom >= 0, "持续向下走应最终顶到下边界");
    for (let i = 0; i < 5; i++) panel.frame(100);
    assert.ok(panel.pos().y < maxY, "撞下边界后应反弹向上，而不是卡在边缘");
});

test("pet.html 兼容性：omniWander=false 退回原来的水平来回走", async () => {
    const panel = await createPanel({ omniWander: false });
    // 区间、是否走、方向：0.0 -> dir = -1（向左）
    walkWith(panel, 0.0);
    const a = panel.pos();
    for (let i = 0; i < 30; i++) panel.frame(16);
    const b = panel.pos();

    assert.ok(b.x < a.x, "关闭全向时应仍沿水平方向移动");
    assert.equal(b.top, "", "关闭全向时不应启用纵向定位");
    assert.equal(b.y, null, "关闭全向时 y 应保持未启用");
    assert.ok(b.bottom !== "" && b.bottom !== undefined, "关闭全向时应继续用底边定位");
    assert.equal(b.flipped, true, "向左走应复用向左动画");
});

test("pet.html 兼容性：旧 pet.json 没写 omniWander 时默认开启全向走动", async () => {
    const panel = await createPanel({});   // behavior 里完全没有 omniWander 字段
    assert.equal(Object.prototype.hasOwnProperty.call(panel.cfg.behavior, "omniWander"), false);

    // 先向上走一段离开底边（首次走动从底边起步），再验证斜向
    walkWith(panel, 0.75);                 // 3PI/2 = 向上
    for (let i = 0; i < 200; i++) panel.frame(100);

    walkWith(panel, 0.125);                // PI/4 = 右下
    const a = panel.pos();
    for (let i = 0; i < 20; i++) panel.frame(16);
    const b = panel.pos();
    assert.ok(b.x > a.x && b.y > a.y, "缺省（无该字段）时应表现为全向移动");
});
