// 审计日志：记录插件关键动作（应用/回滚/开关/重试/配置变更）。
// 极简容错：写入失败绝不中断主流程。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUDIT_FILE = "audit.jsonl";
export const AUDIT_MAX_BYTES = 1024 * 1024;
export const AUDIT_KEEP = 2;

function dshHome(explicit) {
  if (explicit) return explicit;
  const env = String(process.env.DSH_HOME || "").trim();
  if (env) return env;
  return path.join(os.homedir(), ".dsh");
}

function auditPath(home) {
  return path.join(home || dshHome(), "dsh-purge", AUDIT_FILE);
}

function rotate(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (st.size < AUDIT_MAX_BYTES) return;
  for (let i = AUDIT_KEEP; i >= 1; i -= 1) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    try {
      fs.renameSync(from, `${file}.${i}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}

let warnedAuditFailure = false;

export function logAudit(event, data = {}, home) {
  try {
    const file = auditPath(home);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rotate(file);
    const row = { at: new Date().toISOString(), event, pid: process.pid, ...data };
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
    return true;
  } catch (e) {
    if (!warnedAuditFailure) {
      warnedAuditFailure = true;
      try {
        console.error(`[dsh-purge] 审计写入失败: ${e && e.message ? e.message : e}`);
      } catch {
        /* ignore */
      }
    }
    return false;
  }
}

export function readAudit({ limit = 50, home } = {}) {
  const file = auditPath(home);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* ignore truncated line */
    }
  }
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 50;
  return rows.slice(-n).reverse();
}
