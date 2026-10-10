import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

test("Windows 5.1: 原生库操作、C# 编译和真实会话标题窗口查找", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const dir = await mkdtemp(path.join(os.tmpdir(), "pet-native-test-"));
    try {
        const result = await new Promise((resolve, reject) => {
            const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File",
                path.join(repo, "tests", "windows-smoke.ps1"), "-RepoDir", repo, "-TestDir", dir], { windowsHide: true });
            let output = "";
            child.stdout.on("data", (chunk) => { output += chunk; });
            child.stderr.on("data", (chunk) => { output += chunk; });
            child.on("error", reject);
            child.on("exit", (code) => resolve({ code, output }));
        });
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /PASS:/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
