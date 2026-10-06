// tests/helpers.mjs —— 零依赖测试脚手架
// 1) 把仓库文件复制到临时目录，并在那里生成 @github/copilot-sdk stub（仓库本地没有该包）
// 2) 选空闲端口 / 隔离 TEMP 与 USERPROFILE（心跳注册表 + session-state 都落在沙箱内）/ spawn extension.mjs
// 3) 等待 HTTP 就绪、HTTP/SSE 小工具、进程与临时目录清理
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.resolve(HERE, "..");

// NOTES-contract.md §7 给出的 stub 形状
const SDK_STUB = [
    "export function joinSession(opts) { return { on() {}, log: async () => {}, tools: opts.tools, canvases: opts.canvases }; }",
    "export function createCanvas(o) { return o; }",
    "",
].join("\n");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取一个当前空闲的 TCP 端口（先 listen(0) 再关闭，存在极小竞态） */
export function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

async function removeDir(dir) {
    for (let i = 0; i < 6; i++) {
        try { await rm(dir, { recursive: true, force: true }); return; }
        catch { await sleep(150); }
    }
    await rm(dir, { recursive: true, force: true });
}

/** 复制仓库到临时目录，写入 SDK stub；petJson 给出时写入 pet.json */
export async function makeSandbox(opts) {
    const o = opts || {};
    const dir = await mkdtemp(path.join(os.tmpdir(), "pet-test-"));
    await cp(REPO_DIR, dir, {
        recursive: true,
        filter: (src) => ![".git", "node_modules"].includes(path.basename(src)),
    });

    const stubDir = path.join(dir, "node_modules", "@github", "copilot-sdk");
    await mkdir(stubDir, { recursive: true });
    await writeFile(path.join(stubDir, "package.json"), JSON.stringify({
        name: "@github/copilot-sdk",
        version: "0.0.0-test-stub",
        type: "module",
        exports: { "./extension": "./extension.mjs" },
    }, null, 2));
    await writeFile(path.join(stubDir, "extension.mjs"), SDK_STUB);

    if (o.petJson !== undefined) {
        await writeFile(path.join(dir, "pet.json"), JSON.stringify(o.petJson, null, 2));
    }
    const extra = o.extraFiles || {};
    for (const rel of Object.keys(extra)) {
        const fp = path.join(dir, rel);
        await mkdir(path.dirname(fp), { recursive: true });
        await writeFile(fp, extra[rel]);
    }
    await mkdir(path.join(dir, "tmp"), { recursive: true });
    await mkdir(path.join(dir, "home"), { recursive: true });
    return { dir, cleanup: () => removeDir(dir) };
}

/** TEMP/USERPROFILE 全部指向沙箱，避免污染真实心跳注册表与 ~/.copilot/session-state */
function sandboxEnv(dir) {
    const tmp = path.join(dir, "tmp");
    const home = path.join(dir, "home");
    return {
        TEMP: tmp,
        TMP: tmp,
        USERPROFILE: home,
        HOME: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
    };
}

/** 单次 HTTP 请求，返回 { status, headers, text, json } */
export function httpRequest(port, method, urlPath, opts) {
    const o = opts || {};
    return new Promise((resolve, reject) => {
        const payload = o.body === undefined ? null
            : (typeof o.body === "string" ? o.body : JSON.stringify(o.body));
        const headers = Object.assign({}, o.headers || {});
        if (payload !== null) {
            if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(payload);
        }
        const req = http.request({ host: "127.0.0.1", port: port, path: urlPath, method: method, headers: headers }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
                resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
            });
        });
        req.setTimeout(o.timeoutMs || 10000, () => req.destroy(new Error("HTTP 请求超时 " + method + " " + urlPath)));
        req.on("error", reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

/**
 * spawn extension.mjs 并等待 /api/state 就绪。
 * 返回 { child, port, dir, ready, exited, request, stop, running, stdout, stderr }
 */
export async function startExtension(opts) {
    const o = opts || {};
    const dir = o.dir;
    const env = o.env || {};
    const args = o.args || ["extension.mjs"];
    const readyTimeoutMs = o.readyTimeoutMs || 20000;
    const waitForReady = o.waitForReady !== false;

    const child = spawn(process.execPath, args, {
        cwd: dir,
        env: Object.assign({}, process.env, sandboxEnv(dir), env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr += d; });

    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code: code, signal: signal })));
    const port = Number(env.PET_HTTP_PORT);

    const ext = {
        child: child,
        dir: dir,
        port: port,
        exited: exited,
        ready: false,
        get stdout() { return stdout; },
        get stderr() { return stderr; },
        get running() { return child.exitCode === null && !child.killed; },
        request: (method, urlPath, reqOpts) => httpRequest(port, method, urlPath, reqOpts),
        stop: async () => {
            if (child.exitCode !== null) { await exited; return; }
            child.kill();
            const done = await Promise.race([exited.then(() => true), sleep(4000).then(() => false)]);
            if (!done && child.exitCode === null) child.kill("SIGKILL");
            await Promise.race([exited, sleep(2000)]);
        },
    };

    if (waitForReady) {
        const deadline = Date.now() + readyTimeoutMs;
        let lastErr = null;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                await ext.stop();
                throw new Error("extension 提前退出 (code=" + child.exitCode + ")\n--- stdout ---\n" + stdout + "\n--- stderr ---\n" + stderr);
            }
            try {
                const r = await httpRequest(port, "GET", "/api/state", { timeoutMs: 2000 });
                if (r.status === 200) { ext.ready = true; break; }
                lastErr = new Error("GET /api/state -> " + r.status);
            } catch (err) { lastErr = err; }
            await sleep(50);
        }
        if (!ext.ready) {
            await ext.stop();
            throw new Error("extension 未在 " + readyTimeoutMs + "ms 内就绪: " + (lastErr && lastErr.message)
                + "\n--- stdout ---\n" + stdout + "\n--- stderr ---\n" + stderr);
        }
    }
    return ext;
}

function parseSSEFrame(frame) {
    let event = "message";
    const dataLines = [];
    for (const raw of frame.split(/\r?\n/)) {
        if (!raw || raw.startsWith(":")) continue;
        const idx = raw.indexOf(":");
        const field = idx === -1 ? raw : raw.slice(0, idx);
        const value = idx === -1 ? "" : raw.slice(idx + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) return null;
    const data = dataLines.join("\n");
    let parsed = null;
    try { parsed = JSON.parse(data); } catch (e) { /* 非 JSON data */ }
    return { event: event, data: data, parsed: parsed };
}

/** 打开 SSE 连接；waitForEvent(predicate, ms) 等到匹配事件（predicate 收到 {event,data,parsed}） */
export async function openSSE(port, urlPath, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 15000;
    const events = [];
    const waiters = [];
    const notify = () => {
        for (const w of waiters.slice()) {
            const hits = events.filter(w.predicate);
            if (hits.length) {
                waiters.splice(waiters.indexOf(w), 1);
                clearTimeout(w.timer);
                w.resolve(hits);
            }
        }
    };
    const failAll = (err) => {
        for (const w of waiters.slice()) {
            waiters.splice(waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.reject(err);
        }
    };

    const req = http.request({
        host: "127.0.0.1", port: port, path: urlPath || "/api/events", method: "GET",
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
    });
    const res = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SSE 连接超时 " + urlPath)), timeoutMs);
        req.once("response", (r) => { clearTimeout(timer); resolve(r); });
        req.once("error", (e) => { clearTimeout(timer); reject(e); });
        req.end();
    });

    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
        buf += chunk;
        let idx = buf.search(/\r\n\r\n|\n\n/);
        while (idx !== -1) {
            const sepLen = buf.startsWith("\r\n\r\n", idx) ? 4 : 2;
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + sepLen);
            const ev = parseSSEFrame(frame);
            if (ev) { events.push(ev); notify(); }
            idx = buf.search(/\r\n\r\n|\n\n/);
        }
    });
    res.on("error", (e) => failAll(e));

    return {
        status: res.statusCode,
        contentType: res.headers["content-type"],
        events: events,
        waitForEvent: (predicate, ms) => {
            const hits = events.filter(predicate);
            if (hits.length) return Promise.resolve(hits);
            return new Promise((resolve, reject) => {
                const w = { predicate: predicate, resolve: resolve, reject: reject, timer: null };
                w.timer = setTimeout(() => {
                    const i = waiters.indexOf(w);
                    if (i !== -1) waiters.splice(i, 1);
                    reject(new Error("SSE 等待超时 (" + (ms || timeoutMs) + "ms)：已收到 " + events.length + " 个事件，最后 3 个="
                        + JSON.stringify(events.slice(-3))));
                }, ms || timeoutMs);
                waiters.push(w);
            });
        },
        close: () => { try { req.destroy(); res.destroy(); } catch (e) { /* ignore */ } },
    };
}

/** 轮询等待条件成立；条件抛错也会继续重试，超时后带上最后取值报错 */
export async function waitFor(fn, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 10000;
    const intervalMs = o.intervalMs || 50;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const v = await fn();
            if (v) return v;
            last = v;
        } catch (e) { last = e; }
        await sleep(intervalMs);
    }
    throw new Error("等待 " + (o.label || "condition") + " 超时 (" + timeoutMs + "ms)，最后取值: "
        + (last instanceof Error ? last.message : JSON.stringify(last)));
}
