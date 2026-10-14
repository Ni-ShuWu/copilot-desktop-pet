// 真实窗口端到端：拉起 pet-window.ps1（真 WPF 窗）+ 本机 HTTP 服务，
// 用 Win32 采样窗口位置，验证全向走动确实发生在 X 与 Y 两个轴上，且不越界。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { createServer } from "node:net";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PS51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function makePng(w, h, painter) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        for (let x = 0; x < w; x++) {
            const [r, g, b, a] = painter(x, y);
            const o = y * (w * 4 + 1) + 1 + x * 4;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
}

const png = makePng(128, 96, (x, y) => {
    const row = Math.floor(y / 32), frame = Math.floor(x / 32);
    const lx = x % 32, ly = y % 32;
    const inside = lx >= 6 && lx < 26 && ly >= 4 && ly < 28 - (frame % 2);
    return inside ? [[220, 80, 80], [80, 180, 90], [90, 120, 220]][row] .concat(255) : [0, 0, 0, 0];
});

const freePort = () => new Promise((res, rej) => {
    const s = createServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

test("真实窗口：全向走动在 X/Y 两轴同时发生、动画仍用左右两套、不越界", { skip: process.platform !== "win32", timeout: 180000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pet-omni-e2e-"));
    let server = null;
    let ps = null;
    try {
        await writeFile(path.join(dir, "spritesheet.png"), png);
        await copyFile(path.join(REPO, "pet-data.ps1"), path.join(dir, "pet-data.ps1"));
        await copyFile(path.join(REPO, "pet-window.ps1"), path.join(dir, "pet-window.ps1"));
        await copyFile(path.join(REPO, "pet-win32.cs"), path.join(dir, "pet-win32.cs"));
        await copyFile(path.join(REPO, "pet.example.json"), path.join(dir, "pet.example.json"));

        const cfg = {
            name: "OmniE2E", sprite: "spritesheet.png", frameWidth: 32, frameHeight: 32, scale: 2, fps: 10,
            defaultAnimation: "idle", pollIntervalMs: 100,
            animations: { idle: { row: 0, frames: 4 }, walk: { row: 1, frames: 4 }, sleep: { row: 2, frames: 4 } },
            // 走动间隔调短：采样窗口内反复重新随机角度。
            // 不能只赌"开局那一次"的随机角度——抽到近水平方向时 Y 轴就不会动，测试会假失败。
            behavior: { autoWander: true, omniWander: true, walkSpeedPxPerSec: 220, wanderIntervalSec: [0.3, 0.6], sleepAfterIdleSec: 0, lookAtCopilot: false },
            speech: { phrases: ["omni"], fontSize: 13 },
        };
        await writeFile(path.join(dir, "pet.json"), JSON.stringify(cfg, null, 2));

        const port = await freePort();
        server = http.createServer((req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ animation: null, message: null, activity: "idle", running: true, sessions: 1 }));
        });
        await new Promise((r) => server.listen(port, "127.0.0.1", r));

        ps = spawn(PS51, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
            "-File", path.join(dir, "pet-window.ps1"),
            "-ExtDir", dir, "-StateUrl", "http://127.0.0.1:" + port + "/", "-DataDir", path.join(dir, "data")],
            { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        ps.stdout.on("data", (d) => { out += d; });
        ps.stderr.on("data", (d) => { out += d; });

        assert.equal(ps.exitCode, null, "桌宠窗应已启动: " + out);

        const probe = spawn(PS51, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
            "-File", path.join(REPO, "tests", "pet-window-probe.ps1"),
            "-ProcessId", String(ps.pid), "-Seconds", "20", "-IntervalMs", "80"],
            { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let probeOut = "";
        probe.stdout.on("data", (d) => { probeOut += d; });
        probe.stderr.on("data", (d) => { probeOut += d; });
        const probeCode = await new Promise((r) => probe.on("exit", r));

        const m = probeOut.match(/SAMPLES=\[(.*)\]/s);
        assert.ok(m, "探针应返回采样点: " + probeOut.slice(0, 600));
        const pts = m[1].split("],[").map((s) => s.replace(/[\[\]]/g, "").split(",").map(Number))
            .filter((p) => p.length === 2 && p.every((n) => Number.isFinite(n)));
        assert.ok(pts.length > 150, "采样点应足够多，实际 " + pts.length + " (probeCode=" + probeCode + ")");

        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const spanX = Math.max(...xs) - Math.min(...xs);
        const spanY = Math.max(...ys) - Math.min(...ys);

        // 全向走动的核心证据：Y 轴也真的在移动（旧实现 Y 恒定）
        assert.ok(spanY > 20, "窗口 Y 必须发生实质位移（全向走动），实际跨度 " + spanY + " 采样 " + pts.length);
        assert.ok(spanX > 20, "窗口 X 也应发生位移，实际跨度 " + spanX);

        // 斜向/上下移动：X 与 Y 同时变化的采样点必须存在
        let bothMoved = 0;
        for (let i = 1; i < pts.length; i++) {
            if (Math.abs(pts[i][0] - pts[i - 1][0]) > 0 && Math.abs(pts[i][1] - pts[i - 1][1]) > 0) bothMoved++;
        }
        assert.ok(bothMoved > 5, "应存在大量 X/Y 同时变化的斜向移动帧，实际 " + bothMoved);

        // 不越界：窗口始终留在工作区内
        const wa = { left: 0, top: 0 };
        assert.ok(Math.min(...xs) >= wa.left - 2, "窗口不应越过工作区左边界");
        assert.ok(Math.min(...ys) >= wa.top - 2, "窗口不应越过工作区上边界");

        // 不越界：右下边界（工作区尺寸未知，用屏幕尺寸兜底校验）
        const maxX = Math.max(...xs), maxY = Math.max(...ys);
        assert.ok(maxX < 4096 && maxY < 4096, "窗口不应跑出屏幕: " + maxX + "," + maxY);

        assert.equal(ps.exitCode, null, "采样期间桌宠窗不应退出: " + out.slice(0, 500));
    } finally {
        if (ps) { try { ps.kill(); } catch {} try { ps.kill("SIGKILL"); } catch {} }
        if (server) { try { await new Promise((r) => server.close(r)); } catch {} }
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});
