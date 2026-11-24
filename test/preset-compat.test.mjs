import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPresetDefinition } from "../lib/redteam/preset-composition.js";
import {
  profileOwnsPreset,
  registerPresetDefinitions,
} from "../lib/preset-compat.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const redteamPresetDir = path.join(repoRoot, "presets", "redteam");

const walk = (rows) =>
  rows.flatMap((row) => (row.group ? [row, ...walk(row.config)] : [row]));
const spawn = (def) =>
  walk(def.plugins).find(
    (row) =>
      row.name === "@deepseek-ai/dsh-tool-subagent" &&
      row.config?.provider === "spawn",
  );
const definition = () => readPresetDefinition("redteam", redteamPresetDir);

test("bundled redteam preset targets 0.2.2-rc.5 cleanly", () => {
  const def = definition();
  const rows = walk(def.plugins);
  assert.equal(
    rows.some((r) => r.id === "tool-subagent-list-agents" || String(r.name || "").endsWith("/list-agents")),
    false,
    "list-agents subpath removed",
  );
  const s = spawn(def);
  assert.equal(s.config.modelSelection, true);
  assert.equal(s.config.modelSelectionSettings, undefined);
  assert.equal(s.config.maxDepth, 1);
  assert.equal(s.config.toolFilter, undefined);
});

test("native activation failures unwind helpers; successful registration disposes parent first exactly once", async () => {
  const parent = definition();
  const child = { id: "redteam-child", name: "Red Team Child", plugins: [] };
  const defs = [child, parent];
  const events = [];
  const reg = {
    async register(def) {
      events.push("+" + def.id);
      return async () => {
        events.push("-" + def.id);
      };
    },
    async resolve(id) {
      return {
        id,
        ...(id === "redteam" ? { broken: "actual Loader error" } : {}),
      };
    },
  };
  await assert.rejects(registerPresetDefinitions(reg, defs), /actual Loader error/);
  assert.deepEqual(events, ["+redteam-child", "+redteam", "-redteam", "-redteam-child"]);
  events.length = 0;
  reg.resolve = async (id) => ({ id });
  const release = await registerPresetDefinitions(reg, defs);
  await release();
  await release();
  assert.deepEqual(events, ["+redteam-child", "+redteam", "-redteam", "-redteam-child"]);
});

test("registration defers only to an effective declaration in the running profile", () => {
  function entry(id, configId, disabled = false, owner = "include", name = "@deepseek-ai/dsh-agent-preset") {
    return {
      options: { id, name, config: { id: configId } },
      disabled,
      parent: { tree: { ctx: { fiber: { entry: { id: owner } } } } },
    };
  }
  const active = [];
  const ctx = { get: () => ({ entries: () => active.values() }) };
  active.push(
    entry("preset-notes", "other"),
    entry("notes", "notes", true),
    entry("nested", "notes", false, "include:other"),
    entry("service", "notes", false, "include", "unrelated"),
  );
  assert.equal(profileOwnsPreset(ctx, "notes"), false);
  active.push(entry("arbitrary-name", "notes"));
  assert.equal(profileOwnsPreset(ctx, "notes"), true);
  assert.equal(profileOwnsPreset({}, "notes"), false);
});

test("redteam entry imports every preset-compat helper it calls", async () => {
  const source = await fs.promises.readFile(new URL("../lib/redteam/index.js", import.meta.url), "utf8");
  const imported = source.match(/import \{([\s\S]*?)\} from ['"]\.\.\/preset-compat\.js['"]/);
  assert(imported, "preset-compat import present");
  for (const name of ["registerPresetDefinitions", "profileOwnsPreset"]) {
    assert.match(imported[1], new RegExp(`(^|[,\\s])${name}($|[,\\s])`), `${name} imported`);
  }
});
