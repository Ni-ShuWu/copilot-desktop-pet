import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, stat, copyFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

export const BUILTIN_ID = "00000000-0000-4000-8000-000000000001";
export const validPetId = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ""));
const hash = (text) => createHash("sha256").update(text.replace(/^\uFEFF/, "")).digest("hex");
async function optionalRead(file) {
    try { return await readFile(file, "utf8"); }
    catch (err) { if (err.code === "ENOENT") return null; throw err; }
}
export async function atomicJson(file, value) {
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, file);
}
export async function installBuiltin(dataDir, extDir) {
    const marker = path.join(dataDir, ".builtin-installed");
    if (await optionalRead(marker) !== null) return;
    const dir = path.join(dataDir, "pets", BUILTIN_ID);
    await mkdir(dir, { recursive: true });
    await copyFile(path.join(extDir, "assets", "octocat.png"), path.join(dir, "octocat.png"));
    const cfg = JSON.parse(await readFile(path.join(extDir, "assets", "octocat.json"), "utf8"));
    await atomicJson(path.join(dir, "pet.json"), cfg);
    await writeFile(marker, "", "utf8");
    return cfg;
}
// Both extension and standalone window use this hash journal. Only a changed
// source can replace the working copy; old source files cannot undo a switch.
export async function snapshotSources(dataDir, extDir) {
    const legacy = await optionalRead(path.join(extDir, "pet.json"));
    let id = "";
    try { id = JSON.parse(await readFile(path.join(dataDir, "pets", "active.json"), "utf8")).id; } catch {}
    const library = validPetId(id) ? await optionalRead(path.join(dataDir, "pets", id, "pet.json")) : null;
    const journal = { legacy: legacy === null ? null : hash(legacy), id, library: library === null ? null : hash(library) };
    await atomicJson(path.join(dataDir, ".config-sources.json"), journal);
    return journal;
}
export async function syncSources(dataDir, extDir) {
    const file = path.join(dataDir, "pet.json");
    const journalRaw = await optionalRead(path.join(dataDir, ".config-sources.json"));
    if (!journalRaw) {
        // Upgrade: pick up edits made to the old file after the one-off migration.
        const legacyFile = path.join(extDir, "pet.json");
        const legacy = await optionalRead(legacyFile);
        if (legacy !== null && (await stat(legacyFile)).mtimeMs > (await stat(file)).mtimeMs) {
            await applySource(file, legacy, extDir, dataDir, "");
        }
        await snapshotSources(dataDir, extDir);
        return;
    }
    const previous = JSON.parse(journalRaw);
    const legacy = await optionalRead(path.join(extDir, "pet.json"));
    let id = "";
    try { id = JSON.parse(await readFile(path.join(dataDir, "pets", "active.json"), "utf8")).id; } catch {}
    const library = validPetId(id) ? await optionalRead(path.join(dataDir, "pets", id, "pet.json")) : null;
    // Explicit switching is authoritative. Never replay an old library snapshot.
    if (legacy !== null && hash(legacy) !== previous.legacy) {
        await applySource(file, legacy, extDir, dataDir, "");
        await atomicJson(path.join(dataDir, "pets", "active.json"), { id: "" });
    } else if (id === previous.id && library !== null && hash(library) !== previous.library) {
        await applySource(file, library, path.join(dataDir, "pets", id), dataDir, id);
    } else if (id === previous.id && (library === null ? null : hash(library)) === previous.library
        && (legacy === null ? null : hash(legacy)) === previous.legacy) return;
    await snapshotSources(dataDir, extDir);
}
async function applySource(file, raw, sourceDir, dataDir, id) {
    const cfg = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!cfg || Array.isArray(cfg) || typeof cfg !== "object") throw new Error("配置必须是 JSON 对象");
    const sprite = String(cfg.sprite || "");
    if (path.basename(sprite) !== sprite || !/\.(png|gif|webp)$/i.test(sprite)) throw new Error("配置中的贴图路径无效");
    if (id) cfg.sprite = path.join("pets", id, sprite);
    else await copyFile(path.join(sourceDir, sprite), path.join(dataDir, sprite));
    await atomicJson(file, cfg);
}
