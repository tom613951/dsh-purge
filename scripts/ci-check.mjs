import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS_EXTS = new Set([".js", ".mjs", ".cjs"]);
const TEXT_EXTS = new Set([".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".md", ".sh", ".html"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);

function walkRepoFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRepoFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function hasUtf8Bom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

const DSH_ALLOWED_SCHEMA_KEYWORDS = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
]);

function validateSchemaObjects(node, toolName, nodePath, errors) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      validateSchemaObjects(node[i], toolName, `${nodePath}[${i}]`, errors);
    }
    return;
  }
  for (const key of Object.keys(node)) {
    if (!DSH_ALLOWED_SCHEMA_KEYWORDS.has(key)) {
      errors.push(`[schema] ${toolName}.${nodePath}: unsupported DSH JSON schema keyword ${JSON.stringify(key)}`);
    }
  }
  if (node.type === "object" && typeof node.additionalProperties !== "boolean") {
    errors.push(`[schema] ${toolName}.${nodePath}: type="object" missing boolean additionalProperties`);
  }
  if (node.properties && typeof node.properties === "object") {
    for (const [propKey, propVal] of Object.entries(node.properties)) {
      validateSchemaObjects(propVal, toolName, `${nodePath}.properties.${propKey}`, errors);
    }
  }
  if (node.items !== undefined) {
    validateSchemaObjects(node.items, toolName, `${nodePath}.items`, errors);
  }
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    validateSchemaObjects(node.additionalProperties, toolName, `${nodePath}.additionalProperties`, errors);
  }
  if (Array.isArray(node.oneOf)) {
    validateSchemaObjects(node.oneOf, toolName, `${nodePath}.oneOf`, errors);
  }
}

function checkToolSet(label, tools, { maxTotalTokens, maxSingleTokens }, errors) {
  const seen = new Set();
  let totalTokens = 0;
  let totalChars = 0;
  let maxTool = { name: "", tokens: 0 };

  for (const tool of tools) {
    const toolName = String(tool?.name || "");
    if (!toolName) {
      errors.push(`[tools:${label}] registered tool missing name`);
      continue;
    }
    if (seen.has(toolName)) {
      errors.push(`[tools:${label}] duplicate tool name: ${toolName}`);
    }
    seen.add(toolName);

    const schema = tool.parameters ?? tool.inputSchema ?? tool.schema ?? null;
    if (schema) {
      validateSchemaObjects(schema, `${label}:${toolName}`, "parameters", errors);
    }
    const payload = JSON.stringify({
      name: toolName,
      description: String(tool.description || ""),
      parameters: schema,
    });
    const chars = payload.length;
    const tokens = Math.ceil(chars / 4);
    totalChars += chars;
    totalTokens += tokens;
    if (tokens > maxTool.tokens) maxTool = { name: toolName, tokens };
    if (tokens > maxSingleTokens) {
      errors.push(`[tools:${label}] tool ${toolName} (${tokens} est. tokens) exceeds maxSingleTokens (${maxSingleTokens})`);
    }
  }

  if (totalTokens > maxTotalTokens) {
    errors.push(`[tools:${label}] total ${totalTokens} est. tokens exceeds maxTotalTokens (${maxTotalTokens})`);
  }
  console.log(
    `[ci-check] ${label} tools=${tools.length} chars=${totalChars} estTokens=${totalTokens}/${maxTotalTokens} maxSingle=${maxTool.name || "-"}:${maxTool.tokens}/${maxSingleTokens}`,
  );
}

async function main() {
  const errors = [];
  const files = walkRepoFiles(REPO_ROOT);

  let syntaxChecked = 0;
  let bomChecked = 0;
  for (const fp of files) {
    const ext = path.extname(fp).toLowerCase();
    const rel = path.relative(REPO_ROOT, fp);
    if (JS_EXTS.has(ext)) {
      syntaxChecked += 1;
      try {
        execFileSync(process.execPath, ["--check", fp], { stdio: "pipe" });
      } catch (err) {
        const stderr = err?.stderr ? String(err.stderr).trim() : String(err?.message || err);
        errors.push(`[syntax] ${rel}: ${stderr}`);
      }
    }
    if (TEXT_EXTS.has(ext)) {
      bomChecked += 1;
      const head = Buffer.alloc(3);
      const fd = fs.openSync(fp, "r");
      let n = 0;
      try {
        n = fs.readSync(fd, head, 0, 3, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (n === 3 && hasUtf8Bom(head)) {
        errors.push(`[bom] UTF-8 BOM detected in ${rel}`);
      }
    }
  }
  console.log(`[ci-check] syntax=${syntaxChecked} bomScan=${bomChecked}`);

  const pkgPath = path.join(REPO_ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg?.engines?.dsh !== ">=0.2.0-rc.1 <0.3.0-0") {
    errors.push(`[manifest] engines.dsh expected ">=0.2.0-rc.1 <0.3.0-0", got ${JSON.stringify(pkg?.engines?.dsh)}`);
  }
  if (pkg?.peerDependencies?.["@deepseek-ai/dsh"] !== ">=0.2.0-rc.1 <0.3.0-0") {
    errors.push(
      `[manifest] peerDependencies["@deepseek-ai/dsh"] expected ">=0.2.0-rc.1 <0.3.0-0", got ${JSON.stringify(pkg?.peerDependencies?.["@deepseek-ai/dsh"])}`,
    );
  }
  if (pkg?.peerDependenciesMeta?.["@deepseek-ai/dsh"]?.optional !== true) {
    errors.push(`[manifest] peerDependenciesMeta["@deepseek-ai/dsh"].optional expected true`);
  }
  if (pkg?.dshTarget !== pkg?.version) {
    errors.push(`[manifest] dshTarget (${pkg?.dshTarget}) must match version (${pkg?.version})`);
  }

  const prevDshHome = process.env.DSH_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-ci-"));
  const disposers = [];
  const coreTools = [];
  try {
    process.env.DSH_HOME = tmpHome;
    const indexUrl = pathToFileURL(path.join(REPO_ROOT, "lib", "index.js")).href;
    const indexMod = await import(indexUrl);
    const mockCtx = {
      tools: {
        register(spec) {
          coreTools.push(spec);
          return () => {};
        },
        guard() {
          return () => {};
        },
      },
      systemPrompt: {
        section() {
          return () => {};
        },
        add() {
          return () => {};
        },
        context() {
          return () => {};
        },
      },
      on() {
        return () => {};
      },
      inject() {},
      effect(fn) {
        const d = fn?.();
        if (typeof d === "function") disposers.push(d);
      },
      get() {
        return undefined;
      },
      scope: { active: true },
    };
    await indexMod.apply(mockCtx, {});
    const coreNames = new Set(coreTools.map((t) => t?.name));
    for (const required of ["purge_status", "purge_apply", "purge_revert", "purge_memory"]) {
      if (!coreNames.has(required)) {
        errors.push(`[tools:core] missing required core tool: ${required}`);
      }
    }
    checkToolSet("core", coreTools, { maxTotalTokens: 1500, maxSingleTokens: 650 }, errors);
  } finally {
    for (const d of disposers.splice(0).reverse()) {
      try {
        await d();
      } catch {
        /* ignore */
      }
    }
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  let redteamMod = null;
  try {
    const rtUrl = pathToFileURL(path.join(REPO_ROOT, "lib", "redteam", "tools.js")).href;
    redteamMod = await import(rtUrl);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("@deepseek-ai/dsh-tools") || err?.code === "ERR_MODULE_NOT_FOUND") {
      console.log("[ci-check] redteam tools check skipped (host @deepseek-ai/dsh-tools not installed)");
    } else {
      errors.push(`[redteam] failed to import lib/redteam/tools.js: ${msg}`);
    }
  }

  if (redteamMod) {
    const rtTools = [];
    const rtDisposers = [];
    const stubRedteam = {
      db: () => ({}),
      listEngagements: () => [],
      getEngagement: () => null,
    };
    const rtCtx = {
      redteam: stubRedteam,
      get(key) {
        return key === "redteam" ? stubRedteam : undefined;
      },
      tools: {
        register(spec) {
          rtTools.push(spec);
          return () => {};
        },
        guard() {
          return () => {};
        },
      },
      on() {
        return () => {};
      },
      effect(fn) {
        const d = fn?.();
        if (typeof d === "function") rtDisposers.push(d);
      },
      scope: { active: true },
    };
    try {
      await redteamMod.apply(rtCtx);
      checkToolSet("redteam", rtTools, { maxTotalTokens: 7500, maxSingleTokens: 650 }, errors);
    } finally {
      for (const d of rtDisposers.splice(0).reverse()) {
        try {
          await d();
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`ERROR: ${err}`);
    process.exit(1);
  }
  console.log("[ci-check] ALL CHECKS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
