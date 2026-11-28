import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import * as core from "../lib/core.js";
import { isPermanentFailure, shouldAutoRetry } from "../lib/continue-retry.js";
import { looksLikeRefusal, REFUSAL_PATTERNS } from "../lib/refusal-retry.js";
import { installWebServer, resetStatusCacheForTests } from "../lib/index.js";
import { hideConsoleEntrySource, preserveExecPromise } from "../lib/hide-console.js";
import { foldInjectIntoPersona, rewritePromptAssembly, textCarriesInject } from "../lib/identity.js";
import { isRewindDerivedMessage } from "../lib/rewind.js";
import { readTuning } from "../lib/tuning.js";
import * as revision from "../lib/revision.js";
import { readWorkspacePolicy } from "../lib/rules.js";
import * as redteam from "../lib/redteam/index.js";

function resolveLiveRc5AiBase() {
  const candidates = [];
  if (process.env.DSH_DESKTOP_INSTALL) {
    candidates.push(path.join(process.env.DSH_DESKTOP_INSTALL, "resources", "app", "node_modules", "@deepseek-ai"));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "DSH NEXT", "resources", "app", "node_modules", "@deepseek-ai"));
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return "";
}

function makeReq({ method = "GET", url = "/dsh-purge/status", headers = {}, body = "" } = {}) {
  const req = Readable.from(body ? [Buffer.from(body, "utf8")] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

function makeRes() {
  const out = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      out.status = status;
      out.headers = headers;
    },
    end(chunk = "") {
      out.body += String(chunk || "");
    },
  };
  return out;
}

function collectYamlLiteralLeaks(yamlText) {
  const lines = String(yamlText || "").split(/\r?\n/);
  const leaks = [];
  let inSectionBlock = false;
  let sectionIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^(\s*)section:\s*\|[-+]?\s*$/);
    if (m) {
      inSectionBlock = true;
      sectionIndent = m[1].length;
      continue;
    }
    if (inSectionBlock) {
      if (!line.trim()) continue;
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      if (indent <= sectionIndent) {
        inSectionBlock = false;
        sectionIndent = -1;
      } else if (/#\s*\[dsh-purge/.test(line)) {
        leaks.push({ line: i + 1, text: line });
      }
    }
  }
  return leaks;
}

test("live Windows DSH NEXT 0.2.2-rc.5 .dshpurge.bak dry-run audit passes all 76 patches with 0 dead rules, valid JS syntax, and 0 YAML leaks", async (t) => {
  const liveAiBase = resolveLiveRc5AiBase();
  if (!liveAiBase) {
    t.skip("DSH NEXT 0.2.2-rc.5 installation not found");
    return;
  }

  assert.equal(core.ALL_PATCHES.length, 76);

  const liveAppRoot = path.dirname(path.dirname(liveAiBase));
  const liveInstallRoot = path.dirname(path.dirname(liveAppRoot));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rc5-audit-"));
  const tempHome = path.join(tempRoot, "home");
  const tempInstallRoot = path.join(tempRoot, "DSH NEXT");
  const tempAppRoot = path.join(tempInstallRoot, "resources", "app");
  const tempAiBase = path.join(tempAppRoot, "node_modules", "@deepseek-ai");
  fs.mkdirSync(tempHome, { recursive: true });
  fs.mkdirSync(tempAiBase, { recursive: true });
  fs.writeFileSync(path.join(tempInstallRoot, "DSH NEXT.exe"), "", "utf8");
  const liveAppPkg = path.join(liveAppRoot, "package.json");
  if (fs.existsSync(liveAppPkg)) {
    fs.copyFileSync(liveAppPkg, path.join(tempAppRoot, "package.json"));
  }

  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BASE: process.env.DSH_BASE,
    DSH_SURFACE: process.env.DSH_SURFACE,
    DSH_DESKTOP_INSTALL: process.env.DSH_DESKTOP_INSTALL,
  };

  try {
    process.env.DSH_SURFACE = "desktop";
    process.env.DSH_DESKTOP_INSTALL = liveInstallRoot;
    core.clearDesktopLocateCache();

    const liveTargets = core.targetFiles(liveAiBase, prevEnv.DSH_HOME || path.join(os.homedir(), ".dsh"));
    const allLivePaths = new Set(Object.values(liveTargets).flat().filter(Boolean));
    assert.ok(allLivePaths.size > 0, "expected resolved target files from live installation");

    for (const fp of allLivePaths) {
      const rel = path.relative(liveAppRoot, fp);
      assert.equal(rel.startsWith("..") || path.isAbsolute(rel), false, `unexpected target outside app root: ${fp}`);
      const dst = path.join(tempAppRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const bak = `${fp}.dshpurge.bak`;
      const src = fs.existsSync(bak) ? bak : fp;
      fs.copyFileSync(src, dst);
    }
    const hostProcEntry = path.join(liveAppRoot, "lib", "host-process.js");
    if (fs.existsSync(hostProcEntry)) {
      const dstEntry = path.join(tempAppRoot, "lib", "host-process.js");
      fs.mkdirSync(path.dirname(dstEntry), { recursive: true });
      fs.copyFileSync(hostProcEntry, dstEntry);
    }

    process.env.DSH_HOME = tempHome;
    process.env.DSH_BASE = tempAiBase;
    process.env.DSH_SURFACE = "desktop";
    process.env.DSH_DESKTOP_INSTALL = tempInstallRoot;
    core.clearDesktopLocateCache();

    // Sequential per-rule hit verification across mirrored unpatched rc.5 files
    const mirrorTargets = core.targetFiles(tempAiBase, tempHome);
    const currentTexts = new Map();
    const deadRules = [];
    for (const patch of core.ALL_PATCHES) {
      const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
      const filesForPatch = keys.flatMap((k) => {
        const entry = mirrorTargets[k];
        return Array.isArray(entry) ? entry : (entry ? [entry] : []);
      });
      assert.ok(filesForPatch.length > 0, `no target files resolved for patch #${patch.id} ${patch.name}`);

      const reps = Array.isArray(patch.replacements) ? patch.replacements : [];
      for (const fp of filesForPatch) {
        if (!currentTexts.has(fp)) currentTexts.set(fp, fs.readFileSync(fp, "utf8"));
      }
      for (let i = 0; i < reps.length; i += 1) {
        const singlePatch = { ...patch, replacements: [reps[i]] };
        if (core.isSelfMarkedPatch(singlePatch)) continue;
        let matchedSomewhere = false;
        for (const fp of filesForPatch) {
          const cur = currentTexts.get(fp);
          const applied = core.applyReplacementsToText(cur, singlePatch, path.basename(fp));
          if (applied.changed || core.filePatchOutcome(cur, singlePatch, path.basename(fp)) === "applied") {
            matchedSomewhere = true;
            currentTexts.set(fp, applied.text);
          }
        }
        if (!matchedSomewhere) deadRules.push({ id: patch.id, name: patch.name, rule: i });
      }
    }
    assert.deepEqual(deadRules, [], `dead patch rules found: ${JSON.stringify(deadRules)}`);

    // Full applyPatches convergence & post-apply status audit
    const report1 = await core.applyPatches(tempAiBase, core.ALL_PATCHES);
    const bad1 = report1.filter((r) => r.status !== "applied" && r.status !== "already");
    assert.deepEqual(bad1, [], `unexpected apply failures: ${JSON.stringify(bad1)}`);

    const status = await core.patchStatus(tempAiBase, core.ALL_PATCHES);
    for (const patch of core.ALL_PATCHES) {
      assert.equal(status[patch.id], "applied", `patch #${patch.id} (${patch.name}) status=${status[patch.id]}`);
    }

    const report2 = await core.applyPatches(tempAiBase, core.ALL_PATCHES);
    const nonAlready = report2.filter((r) => r.status !== "already");
    assert.deepEqual(nonAlready, [], `second apply pass must report already: ${JSON.stringify(nonAlready)}`);

    // Syntax check every patched JS/MJS file & YAML block leak check on every patched YML/YAML file
    const mirrorPaths = new Set(Object.values(mirrorTargets).flat().filter(Boolean));
    for (const fp of mirrorPaths) {
      if (/\.(js|mjs)$/i.test(fp)) {
        execFileSync(process.execPath, ["--check", fp], { stdio: "pipe" });
      } else if (/\.ya?ml$/i.test(fp)) {
        const leaks = collectYamlLiteralLeaks(fs.readFileSync(fp, "utf8"));
        assert.deepEqual(leaks, [], `YAML section literal block leak in ${fp}: ${JSON.stringify(leaks)}`);
      }
    }
  } finally {
    core.clearDesktopLocateCache();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fused upstream fixes: #1, #15, #19, #52, #63, #102, #103 apply cleanly and idempotently", () => {
  // #1 WORKSPACE_CONTEXT_INTRO (3 rules)
  const p1 = core.ALL_PATCHES.find((p) => p.id === 1);
  assert.ok(p1 && p1.replacements.length === 3);
  const src1 = [
    'const AGENT_INSTRUCTIONS_INTRO = "The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.";',
    'const REPLACEMENT_AGENT_INSTRUCTIONS_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.";',
    'const ADDITIONAL_INSTRUCTIONS_GUIDANCE = "Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.";',
  ].join("\n");
  const r1 = core.applyReplacementsToText(src1, p1, "index.js");
  assert.equal(r1.changed, true);
  assert.equal(core.filePatchOutcome(r1.text, p1, "index.js"), "applied");
  assert.equal(core.applyReplacementsToText(r1.text, p1, "index.js").changed, false);

  // #15 SANDBOX_CONFINE_PASSTHROUGH (2 rules incl. Windows ACL skill suppression)
  const p15 = core.ALL_PATCHES.find((p) => p.id === 15);
  assert.ok(p15 && p15.replacements.length === 2);
  const src15 = [
    '\t\t/* v8 ignore next 3 -- Windows-only registration; the Linux coverage lane cannot take this branch */',
    '\t\tif (process.platform === "win32" && this.runnerCommand === void 0) ctx.inject(["skills"], (skillsCtx) => {',
    '\t\t\tregisterAclDiagnosisSkill(skillsCtx);',
    '\t\t});',
    "async confine(argv, policy, signal) {",
    "\t\tsignal?.throwIfAborted();",
    "\t\tpolicy = {",
    "\t\t\t...policy,",
    "\t\t\tworkspaceRoot: canonicalPath(policy.workspaceRoot)",
    "\t\t};",
    "\t\tif (this.runnerCommand !== void 0) return Promise.resolve({",
    "\t\t\targv: [",
    "\t\t\t\t...this.runnerCommand,",
    "\t\t\t\t...bwrapProfileArgs(policy),",
    '\t\t\t\t"--",',
    "\t\t\t\t...argv",
    "\t\t\t],",
    '\t\t\tenforcement: "full",',
    "\t\t\tdenialSignatures: DENIAL_SIGNATURES.runnerCommand,",
    "\t\t\trunnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }]",
    "\t\t});",
    "\t\tconst selected = this.selectRunner(policy.mode);",
    "\t\tconst runnerArgv = this.runnerArgv(selected.runner, policy);",
    "\t\treturn Promise.resolve({",
    "\t\t\targv: [",
    "\t\t\t\t...runnerArgv,",
    '\t\t\t\t"--",',
    "\t\t\t\t...argv",
    "\t\t\t],",
    "\t\t\tenforcement: selected.enforcement,",
    "\t\t\tdenialSignatures: DENIAL_SIGNATURES[selected.runner],",
    "\t\t\trunnerFailureRules: RUNNER_FAILURE_RULES[selected.runner]",
    "\t\t});",
    "\t}",
  ].join("\n");
  const r15 = core.applyReplacementsToText(src15, p15, "index.js");
  assert.equal(r15.changed, true);
  assert.equal(core.filePatchOutcome(r15.text, p15, "index.js"), "applied");
  assert.match(r15.text, /windows acl diagnosis skill suppressed/);

  // #52 SESSION_LOG_UPLOAD_DEFAULT_OFF
  const p52 = core.ALL_PATCHES.find((p) => p.id === 52);
  assert.ok(p52 && p52.replacements.length === 2);
  const src52 = "enabled: z.boolean().default(true).volatile(),\nmode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'\n";
  const r52 = core.applyReplacementsToText(src52, p52, "cordis.patch.yml");
  assert.equal(r52.changed, true);
  assert.equal(core.filePatchOutcome(r52.text, p52, "cordis.patch.yml"), "applied");

  // #63 OFFICIAL_PLAN_MODE_NEUTRAL (5 rules)
  const p63 = core.ALL_PATCHES.find((p) => p.id === 63);
  assert.ok(p63 && p63.replacements.length === 5);
  const src63 = p63.replacements.map((rep) => String(rep.pattern)).join("\n");
  const r63 = core.applyReplacementsToText(src63, p63, "preset.yml");
  assert.equal(r63.changed, true);
  assert.equal(core.filePatchOutcome(r63.text, p63, "preset.yml"), "applied");

  // #102 COMPACTION_ANTI_REFUSAL
  const p102 = core.ALL_PATCHES.find((p) => p.id === 102);
  assert.ok(p102);
  const src102 = "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.\n";
  const r102 = core.applyReplacementsToText(src102, p102, "preset.yml");
  assert.equal(r102.changed, true);
  assert.equal(core.filePatchOutcome(r102.text, p102, "preset.yml"), "applied");

  // #103 CUA_APPROVAL_AUTO_GRANT
  const p103 = core.ALL_PATCHES.find((p) => p.id === 103);
  assert.ok(p103 && p103.replacements.length === 2);
  const src103 = [
    '\t\tif (granted === void 0) {',
    '\t\t\tconst questions = this.ctx.get("userQuestions");',
    '\t\t\tif (!questions) throw new NativeError("MOUSE_APPROVAL_UNAVAILABLE", "No human answerer is available for mouse control");',
    '\t\t}',
    '\t\t\tif (!saved && decision?.decision !== "allow") {',
    '\t\t\t\tconst questions = this.ctx.get("userQuestions");',
    '\t\t\t\tif (!questions) throw new NativeError("APP_APPROVAL_UNAVAILABLE", "No human answerer is available for application access");',
    '\t\t\t}',
  ].join("\n");
  const r103 = core.applyReplacementsToText(src103, p103, "index.js");
  assert.equal(r103.changed, true);
  assert.equal(core.filePatchOutcome(r103.text, p103, "index.js"), "applied");
});

test("looksLikePluginDefault protects <!-- purge:layer annotated prompts while detecting unmarked defaults", () => {
  const unmarkedDefault = "<|im_start|>system:\n<project_instructions>\nLittle Code Sauce";
  assert.equal(core.looksLikePluginDefault(unmarkedDefault), true);
  assert.equal(core.looksLikePluginDefault(`<!-- purge:layer=0 -->\n${unmarkedDefault}`), false);
  assert.equal(core.looksLikePluginDefault("Custom user prompt"), false);
});

test("continue-retry classifies safety refusal error codes as permanent", () => {
  for (const code of ["CONTENT_REFUSED", "SAFETY", "SAFETY_BLOCK", "CONTENT_FILTER", "POLICY_VIOLATION"]) {
    assert.equal(isPermanentFailure(code), true, `expected ${code} to be permanent`);
    assert.equal(shouldAutoRetry({ code }), false, `expected shouldAutoRetry false for ${code}`);
  }
  assert.equal(isPermanentFailure("ETIMEDOUT"), false);
  assert.equal(shouldAutoRetry({ code: "ETIMEDOUT" }), true);
});

test("refusal-retry detects English and Chinese checkpoint-restated refusals", () => {
  assert.ok(REFUSAL_PATTERNS.length >= 19);
  assert.equal(looksLikeRefusal("Per the prior checkpoint, I cannot provide that module."), true);
  assert.equal(looksLikeRefusal("上文检查点已明确拒绝提供该步骤，这里不再继续。"), true);
  assert.equal(looksLikeRefusal("Here is the verified configuration output."), false);
});

test("redteam/tools.js prefers subagents.listDescendants over listChildren", async () => {
  const src = fs.readFileSync(new URL("../lib/redteam/tools.js", import.meta.url), "utf8");
  const fnStart = src.indexOf("async function liveRunningChildren");
  assert.ok(fnStart > 0);
  const idxDesc = src.indexOf("subagents.listDescendants", fnStart);
  const idxChild = src.indexOf("subagents.listChildren", fnStart);
  assert.ok(idxDesc > fnStart && idxChild > idxDesc, "listDescendants must take precedence over listChildren");
});

test("/dsh-purge/status 12s SWR cache, rev invalidation, and /dsh-purge/workspace-policy work end-to-end", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-http-swr-"));
  const tempHome = path.join(tempRoot, "home");
  const tempBase = path.join(tempRoot, "base");
  const agentInstrDir = path.join(tempBase, "dsh-agent-instructions", "lib");
  fs.mkdirSync(tempHome, { recursive: true });
  fs.mkdirSync(agentInstrDir, { recursive: true });

  const p1 = core.ALL_PATCHES.find((p) => p.id === 1);
  assert.ok(p1);
  const cleanInstr = p1.replacements.map((r) => String(r.pattern)).join("\n");
  const patchedInstr = p1.replacements.map((r) => String(r.replace)).join("\n");
  const targetJs = path.join(agentInstrDir, "index.js");
  fs.writeFileSync(targetJs, cleanInstr, "utf8");

  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BASE: process.env.DSH_BASE,
    DSH_SURFACE: process.env.DSH_SURFACE,
    DSH_DESKTOP_INSTALL: process.env.DSH_DESKTOP_INSTALL,
  };
  process.env.DSH_HOME = tempHome;
  process.env.DSH_BASE = tempBase;
  process.env.DSH_SURFACE = "web";
  delete process.env.DSH_DESKTOP_INSTALL;
  core.clearDesktopLocateCache();
  resetStatusCacheForTests();
  revision.resetRevForTests();

  const routes = [];
  const webServer = {
    host: "127.0.0.1",
    register(spec) {
      routes.push(spec);
      return () => {};
    },
  };
  const ctx = {
    get(name) {
      if (name === "connection") return { trustedHosts: ["127.0.0.1"] };
      return null;
    },
    inject(deps, fn) {
      if (deps.includes("webServer")) {
        fn({ webServer, effect(cb) { cb(); }, get: (name) => ctx.get(name) });
      }
      if (deps.includes("connection")) {
        fn({ get: (name) => ctx.get(name) });
      }
    },
  };

  try {
    installWebServer(ctx, { enabled: true });
    const statusRoute = routes.find((r) => r.path === "/dsh-purge/status");
    const policyRoute = routes.find((r) => r.path === "/dsh-purge/workspace-policy");
    assert.ok(statusRoute, "missing /dsh-purge/status");
    assert.ok(policyRoute, "missing /dsh-purge/workspace-policy");

    const headersGet = { host: "127.0.0.1:43120" };
    const headersPost = { host: "127.0.0.1:43120", origin: "http://127.0.0.1:43120" };

    // 1. Cold status builds and caches payload
    const s1 = makeRes();
    await statusRoute.handler(makeReq({ method: "GET", url: "/dsh-purge/status", headers: headersGet }), s1);
    assert.equal(s1.status, 200);
    assert.equal(JSON.parse(s1.body).patch_status["1"], "pending");

    // 2. Patch target on disk behind cache -> second GET within 12s still serves cached payload
    fs.writeFileSync(targetJs, patchedInstr, "utf8");
    const s2 = makeRes();
    await statusRoute.handler(makeReq({ method: "GET", url: "/dsh-purge/status", headers: headersGet }), s2);
    assert.equal(s2.status, 200);
    assert.equal(JSON.parse(s2.body).patch_status["1"], "pending");

    // 3. GET /dsh-purge/workspace-policy
    const gp = makeRes();
    await policyRoute.handler(makeReq({ method: "GET", url: "/dsh-purge/workspace-policy", headers: headersGet }), gp);
    assert.equal(gp.status, 200);
    assert.deepEqual(JSON.parse(gp.body), {
      ok: true,
      policy: "fallback",
      policies: ["fallback", "strict", "always"],
    });

    // 4. POST invalid policy returns 400
    const badP = makeRes();
    await policyRoute.handler(
      makeReq({
        method: "POST",
        url: "/dsh-purge/workspace-policy",
        headers: headersPost,
        body: JSON.stringify({ policy: "bogus" }),
      }),
      badP,
    );
    assert.equal(badP.status, 400);

    // 5. POST valid policy persists and invalidates status cache
    const goodP = makeRes();
    await policyRoute.handler(
      makeReq({
        method: "POST",
        url: "/dsh-purge/workspace-policy",
        headers: headersPost,
        body: JSON.stringify({ policy: "strict" }),
      }),
      goodP,
    );
    assert.equal(goodP.status, 200);
    assert.equal(JSON.parse(goodP.body).policy, "strict");
    assert.equal(readWorkspacePolicy(tempHome), "strict");

    // 6. Status now reflects patched disk state after invalidation
    const s3 = makeRes();
    await statusRoute.handler(makeReq({ method: "GET", url: "/dsh-purge/status", headers: headersGet }), s3);
    assert.equal(s3.status, 200);
    assert.equal(JSON.parse(s3.body).patch_status["1"], "applied");

    // 7. Rev bump busts cached status payload immediately even within 12s TTL
    fs.writeFileSync(targetJs, cleanInstr, "utf8");
    revision.bumpRev("apply");
    const s4 = makeRes();
    await statusRoute.handler(makeReq({ method: "GET", url: "/dsh-purge/status", headers: headersGet }), s4);
    assert.equal(s4.status, 200);
    const j4 = JSON.parse(s4.body);
    assert.equal(j4.patch_status["1"], "pending");
    assert.equal(j4.rev, 1);
  } finally {
    resetStatusCacheForTests();
    revision.resetRevForTests();
    core.clearDesktopLocateCache();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("redteam/index.js apply() runs cleanly without undeclared globals and provides redteamMode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-redteam-apply-"));
  const prevHome = process.env.DSH_HOME;
  const prevRt = process.env.REDTEAM_HOME;
  process.env.DSH_HOME = tempRoot;
  process.env.REDTEAM_HOME = path.join(tempRoot, "redteam");

  const provided = {};
  const cleanups = [];
  const registered = [];
  const registry = {
    async register(def) {
      registered.push(def.id);
      return async () => {};
    },
    async list() {
      return registered.map((id) => ({ id }));
    },
  };
  const ctx = {
    agentPresets: registry,
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === "agentPresets") return registry;
      return null;
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") cleanups.push(dispose);
    },
    provide(name, val) {
      provided[name] = val;
    },
  };

  try {
    redteam.apply(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(provided.redteamMode, "redteamMode service must be provided");
    assert.ok(provided.redteamMode.paths, "redteamMode.paths must be present");
    assert.ok(provided.redteamMode.preset, "redteamMode.preset must be present");
    assert.equal("setup" in provided.redteamMode, false, "setupResult should not be referenced");
  } finally {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevRt === undefined) delete process.env.REDTEAM_HOME;
    else process.env.REDTEAM_HOME = prevRt;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("hide-console preserves nodejs.util.promisify.custom and injects windowsHide in both exec and execFile", async () => {
  const customKey = Symbol.for("nodejs.util.promisify.custom");
  const calls = [];
  const origExec = () => {};
  origExec[customKey] = (cmd, opts) => {
    calls.push({ kind: "exec", cmd, opts });
    return Promise.resolve({ stdout: "ok", stderr: "" });
  };
  const wrappedExec = preserveExecPromise(origExec, () => {}, false);
  assert.equal(typeof wrappedExec[customKey], "function");
  await wrappedExec[customKey]("echo hi");
  assert.deepEqual(calls[0], { kind: "exec", cmd: "echo hi", opts: { windowsHide: true } });

  const origExecFile = () => {};
  origExecFile[customKey] = (file, args, opts) => {
    calls.push({ kind: "execFile", file, args, opts });
    return Promise.resolve({ stdout: "ok", stderr: "" });
  };
  const wrappedExecFile = preserveExecPromise(origExecFile, () => {}, true);
  assert.equal(typeof wrappedExecFile[customKey], "function");
  await wrappedExecFile[customKey]("node");
  await wrappedExecFile[customKey]("node", ["--version"]);
  await wrappedExecFile[customKey]("node", { env: { FOO: "1" } });
  assert.deepEqual(calls[1], { kind: "execFile", file: "node", args: [], opts: { windowsHide: true } });
  assert.deepEqual(calls[2], { kind: "execFile", file: "node", args: ["--version"], opts: { windowsHide: true } });
  assert.deepEqual(calls[3], { kind: "execFile", file: "node", args: { env: { FOO: "1" }, windowsHide: true }, opts: undefined });

  const entrySrc = hideConsoleEntrySource();
  assert.match(entrySrc, /function preserveExecPromise/);
  assert.match(entrySrc, /preserveExecPromise\(cp\.exec,/);
  assert.match(entrySrc, /preserveExecPromise\(cp\.execFile,/);
});

test("#58 REWIND_SKIP_DERIVE migrates legacy host, filters only empty rewind markers, and syncs isRewindDerivedMessage", () => {
  const p58 = core.ALL_PATCHES.find((p) => p.id === 58);
  assert.ok(p58);

  const unpatched = [
    '\t\tcase "user/message": return event.data;',
    "\t\tconst msg = this.deriveEventMessage(this.log[seq]);",
    "\t\t\tif (msg) this.derived.push(msg);",
  ].join("\n");
  const rFresh = core.applyReplacementsToText(unpatched, p58, "index.js");
  assert.equal(rFresh.changed, true);
  assert.equal(core.filePatchOutcome(rFresh.text, p58, "index.js"), "applied");
  assert.match(rFresh.text, /\[dsh-purge\] omit empty rewind markers from derived history/);
  assert.equal(core.applyReplacementsToText(rFresh.text, p58, "index.js").changed, false);

  const legacyPatched = [
    '\t\tcase "user/message":\n\t\t\tif (typeof event.data?.id === "string" && event.data.id.indexOf("rewind-") === 0) return null;\n\t\t\treturn event.data; // [dsh-purge] rewind markers stay off the model transcript',
    "\t\tconst msg = this.deriveEventMessage(this.log[seq]);",
    "\t\t\tif (msg) this.derived.push(msg);",
  ].join("\n");
  assert.equal(core.filePatchOutcome(legacyPatched, p58, "index.js"), "pending");
  const rMigrated = core.applyReplacementsToText(legacyPatched, p58, "index.js");
  assert.equal(rMigrated.changed, true);
  assert.equal(core.filePatchOutcome(rMigrated.text, p58, "index.js"), "applied");
  assert.equal(rMigrated.text.includes("[dsh-purge] rewind markers stay off the model transcript"), false);
  assert.ok(rMigrated.text.includes('\t\tcase "user/message": return event.data;'));

  assert.equal(isRewindDerivedMessage({ role: "user", id: "rewind-1", content: [] }), true);
  assert.equal(isRewindDerivedMessage({ role: "user", id: "rewind-1", content: [{ type: "text", text: "hi" }] }), false);
  assert.equal(isRewindDerivedMessage({ role: "assistant", id: "rewind-1", content: [] }), false);
  assert.equal(isRewindDerivedMessage({ role: "user", id: "msg-1", content: [] }), false);
});

test("identity folds into a single persona section and deduplicates CRLF/LF copies", () => {
  const inject = "LINE ONE\nLINE TWO";
  const folded = foldInjectIntoPersona(
    [
      { name: "deployment:persona-prefix", text: "", order: 0 },
      { name: "persona-prefix", text: "You are a helpful software engineer assistant.\nCustom preset note", order: 100 },
    ],
    inject,
  );
  const dep = folded.find((s) => s.name === "deployment:persona-prefix");
  const preset = folded.find((s) => s.name === "persona-prefix");
  assert.equal(dep.text, "");
  assert.equal(textCarriesInject(preset.text, inject), true);

  assert.equal(textCarriesInject("LINE ONE\r\nLINE TWO\r\n", `${inject}\n`), true);

  const assembled = rewritePromptAssembly(
    {
      sections: [
        { name: "deployment:persona-prefix", text: "", order: 0 },
        { name: "persona-prefix", text: "LINE ONE\r\nLINE TWO\r\n\r\nPreset rule", order: 100 },
      ],
    },
    inject,
    { injectPosition: "head", boost: false, capabilityProtocol: false, safetyFilter: false },
  );
  const fullRendered = assembled.sections.map((s) => s.text).join("\n\n");
  assert.equal(fullRendered.split("LINE ONE").length - 1, 1);
});

test("readTuning tolerates UTF-8 BOM and zero-width chars while staying fail-closed on corrupt JSON", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tuning-bom-"));
  const dir = path.join(tmpHome, "dsh-purge");
  const file = path.join(dir, "tuning.json");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `\uFEFF\u200B${JSON.stringify({ injectPosition: "tail", boost: false })}\n`, "utf8");
    const ok = readTuning(tmpHome);
    assert.equal(ok.injectPosition, "tail");
    assert.equal(ok.boost, false);

    fs.writeFileSync(file, "\uFEFF{ broken", "utf8");
    assert.throws(() => readTuning(tmpHome), (err) => err?.code === "TUNING_UNREADABLE");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
