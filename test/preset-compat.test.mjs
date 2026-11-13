import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readPresetDefinition } from "../lib/redteam/preset-composition.js";
import {
  adaptListAgents,
  backupPresetMigration,
  ensureToolExecutor,
  migratePresetDefinition,
  profileOwnsPreset,
  registerPresetDefinitions,
  withLegacyChildIds,
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

function legacyFilteredDefinition() {
  const def = definition();
  const s = spawn(def);
  assert.ok(s, "redteam spawn subagent row exists");
  s.config.toolFilter = { deny: ["subagent_fork", "workflow", "ralph"] };
  return def;
}

test("bundled redteam preset targets 0.2.2-rc.2 cleanly", () => {
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

test("legacy filters become child presets without dropping parent tools, settings or persona", () => {
  const before = legacyFilteredDefinition();
  const original = structuredClone(before);
  const {
    definitions: [child, parent],
    policies,
  } = migratePresetDefinition(before);
  assert.deepEqual(before, original, "caller definition is not modified");
  const expected = structuredClone(original);
  delete spawn(expected).config.toolFilter;
  spawn(expected).config.agentPreset = child.id;
  assert.deepEqual(parent, expected, "only legacy policy replaced on parent");
  assert.deepEqual(
    child.plugins.find((row) => row.id === "persona"),
    before.plugins.find((row) => row.id === "persona"),
  );
  assert.equal(spawn(child).config.maxDepth, 1);
  assert.equal(spawn(child).config.agentPreset, undefined, "no self-reference at activation");
  assert.equal(
    walk(child.plugins).some((row) => ["tool-subagent-fork", "tool-workflow", "tool-ralph"].includes(row.id)),
    false,
  );
  assert.equal(walk(parent.plugins).some((row) => row.id === "tool-subagent-fork"), true);
  assert.deepEqual(policies[0].deny, ["subagent_fork", "workflow", "ralph"]);
  assert.deepEqual(
    migratePresetDefinition(parent),
    { definitions: [parent], policies: [] },
    "modern declarations pass through",
  );
});

test("ambiguous or unrepresentable policies stop without broadening the child tool plane", () => {
  for (const filter of [
    { allow: ["read"] },
    { deny: ["unknown_global_tool"] },
    { deny: ["ralph", "ralph"] },
    null,
  ]) {
    const before = legacyFilteredDefinition();
    spawn(before).config.toolFilter = filter;
    const snapshot = structuredClone(before);
    assert.throws(() => migratePresetDefinition(before), /configuration retained/);
    assert.deepEqual(before, snapshot);
  }
  for (const patch of [
    { provider: "fork" },
    { agentPreset: "custom-child" },
    { allowedAgentPresets: ["custom-child"] },
  ]) {
    const before = legacyFilteredDefinition();
    Object.assign(spawn(before).config, patch);
    assert.throws(() => migratePresetDefinition(before), /configuration retained/);
  }
});

test("backup is byte-exact, idempotent, private under dsh-purge/preset-migrations, and refuses corrupt snapshots", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge-preset-compat-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".agent-presets", "redteam");
  fs.cpSync(redteamPresetDir, dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "agent.cordis.yml"), "# custom user text\r\n");
  const args = {
    home,
    dir,
    id: "redteam",
    policies: migratePresetDefinition(legacyFilteredDefinition()).policies,
  };
  const before = fs.readFileSync(path.join(dir, "agent.cordis.yml"));
  const backup = backupPresetMigration(args);
  assert.ok(backup.includes(path.join("dsh-purge", "preset-migrations")));
  assert.deepEqual(fs.readFileSync(path.join(backup, "agent.cordis.yml")), before);
  assert.deepEqual(fs.readFileSync(path.join(dir, "agent.cordis.yml")), before);
  assert.equal(backupPresetMigration(args), backup);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(backup, "agent.cordis.yml")).mode & 0o777, 0o600);
  }
  fs.writeFileSync(path.join(backup, "preset.yml"), "corrupt");
  assert.throws(() => backupPresetMigration(args), /mismatch/);
  assert.equal(backupPresetMigration({ policies: [] }), undefined);
});

test("native activation failures unwind helpers; successful registration disposes parent first exactly once", async () => {
  const defs = migratePresetDefinition(legacyFilteredDefinition()).definitions;
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
  assert.deepEqual(events, ["+" + defs[0].id, "+redteam", "-redteam", "-" + defs[0].id]);
  events.length = 0;
  reg.resolve = async (id) => ({ id });
  const release = await registerPresetDefinitions(reg, defs);
  await release();
  await release();
  assert.deepEqual(events, ["+" + defs[0].id, "+redteam", "-redteam", "-" + defs[0].id]);
});

test("list_agents is adapted for rc.1, rc.2, and future versions providing registerListAgents", (t) => {
  const name = "@deepseek-ai/dsh-tool-subagent-control";
  const main = { id: "control", name, disabled: false };
  const legacy = { id: "tool-subagent-list-agents", name: name + "/list-agents", disabled: false };

  for (const version of ["0.2.2-rc.1", "0.2.2-rc.2", "0.2.3-rc.1"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "preset-provider-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version, exports: { ".": "./index.js", "./package.json": "./package.json" } }),
    );
    fs.writeFileSync(path.join(dir, "index.js"), "function registerListAgents(){}\nfunction apply(ctx){registerListAgents(ctx)}");
    const anchor = path.join(root, "package.json");
    const input = { plugins: [{ name: "group", group: true, config: [main, legacy] }] };
    const copy = structuredClone(input);
    const out = adaptListAgents(input, anchor);
    assert.deepEqual(out.plugins[0].config, [main]);
    assert.deepEqual(input, copy);
  }

  const gone = fs.mkdtempSync(path.join(os.tmpdir(), "preset-provider-gone-"));
  t.after(() => fs.rmSync(gone, { recursive: true, force: true }));
  const goneDir = path.join(gone, "node_modules", name);
  fs.mkdirSync(goneDir, { recursive: true });
  fs.writeFileSync(path.join(goneDir, "package.json"), JSON.stringify({ name, version: "0.2.3-rc.1", exports: { ".": "./index.js" } }));
  fs.writeFileSync(path.join(goneDir, "index.js"), "export function apply(){}");
  const before = { plugins: [{ name: "group", group: true, config: [main, legacy] }] };
  assert.deepEqual(adaptListAgents(before, path.join(gone, "package.json")), before);
});

test("saved child IDs resolve after host rows move, with the same denied tools", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "preset-history-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const def = legacyFilteredDefinition();
  const old = migratePresetDefinition(def, { stableChildIds: true });
  const p = old.policies[0];
  const oldId =
    def.id +
    "-child-" +
    createHash("sha256").update(JSON.stringify({ at: p.at, deny: p.deny })).digest("hex").slice(0, 10);
  backupPresetMigration({ home, dir: redteamPresetDir, id: def.id, policies: [{ ...p, childId: oldId }] });
  def.plugins.unshift({ name: "qa", id: "user-row" });
  const next = migratePresetDefinition(def, { stableChildIds: true });
  assert.equal(next.policies[0].childId, p.childId);
  assert.notDeepEqual(next.policies[0].at, p.at);
  const definitions = withLegacyChildIds(next, home);
  const alias = definitions.find((x) => x.id === oldId);
  assert.deepEqual(alias.plugins, next.definitions[0].plugins);
  assert.match(alias.name, /历史兼容/);
  assert.equal(new Set(definitions.map((row) => row.name)).size, definitions.length);
  assert.equal(spawn(definitions.at(-1)).config.agentPreset, p.childId);
  spawn(def).config.toolFilter.deny.pop();
  assert.equal(
    withLegacyChildIds(migratePresetDefinition(def, { stableChildIds: true }), home).some((x) => x.id === oldId),
    false,
  );
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

test("a preset that mounts its own tools row gets one native executor in that scope", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preset-executor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = "@deepseek-ai/dsh-tool-executor-native";
  const dir = path.join(root, "node_modules", native);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: native, version: "0.2.2-rc.2" }));
  fs.writeFileSync(path.join(dir, "index.js"), "export function apply(){}");
  const anchor = path.join(root, "package.json");
  const tools = { id: "tools", name: "@deepseek-ai/dsh-tools" };
  const nativeRow = { id: "tool-executor-native", name: native };
  const ptc = { id: "tool-executor-ptc", name: "@deepseek-ai/dsh-tool-executor-ptc", disabled: true };

  const added = ensureToolExecutor({ plugins: [{ id: "g", group: true, config: [tools] }] }, anchor);
  assert.deepEqual(added.plugins[0].config, [tools, nativeRow]);
  assert.deepEqual(
    ensureToolExecutor({ plugins: [{ id: "g", group: true, config: [tools, nativeRow] }] }, anchor).plugins[0].config,
    [tools, nativeRow],
  );
  assert.deepEqual(
    ensureToolExecutor({ plugins: [{ id: "g", group: true, config: [tools, ptc] }] }, anchor).plugins[0].config,
    [tools, ptc],
  );
  assert.deepEqual(
    ensureToolExecutor({ plugins: [{ id: "g", group: true, config: [{ id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" }] }] }, anchor).plugins[0].config[0].id,
    "tool-bash",
  );
});

test("redteam entry imports every preset-compat helper it calls", async () => {
  const source = await fs.promises.readFile(new URL("../lib/redteam/index.js", import.meta.url), "utf8");
  const imported = source.match(/import \{([\s\S]*?)\} from ['"]\.\.\/preset-compat\.js['"]/);
  assert(imported, "preset-compat import present");
  for (const name of [
    "adaptListAgents",
    "ensureToolExecutor",
    "migratePresetDefinition",
    "registerPresetDefinitions",
    "backupPresetMigration",
    "profileOwnsPreset",
  ]) {
    assert.match(imported[1], new RegExp(`(^|[,\\s])${name}($|[,\\s])`), `${name} imported`);
  }
});
