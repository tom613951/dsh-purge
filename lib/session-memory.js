/**
 * Lossless compaction session memory (clean-room Apache-2.0, zero external deps).
 *
 * Lazily archives host session events into an isolated per-(session, workspace)
 * SQLite database only when compaction occurs, a prior archive exists on disk,
 * or `purge_memory` is explicitly queried. Exposes a KV-cache-stable runtime
 * navigation hint after compaction so historical facts remain retrievable.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "./json-safe.js";

export const MEMORY_LIMITS = Object.freeze({
  maxEventBytes: 16 * 1024 * 1024,
  maxSessionBytes: 256 * 1024 * 1024,
  maxActiveSessions: 8,
  pumpBatchEvents: 256,
  pumpBatchMs: 25,
  defaultReadLimit: 2048,
  maxReadLimit: 4096,
  defaultSearchLimit: 8,
  maxSearchLimit: 16,
  defaultExpandLimit: 16,
  maxExpandLimit: 32,
  previewChars: 320,
});

const TRACKED_EVENT_TYPES = new Set([
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
  "compaction/summary",
]);

const SKIP_SOURCE_KINDS = new Set([
  "runtime-context",
  "dsh-purge:session-memory",
]);

let sqliteModulePromise = null;
let cachedNativeFts5 = null;

async function loadSqlite() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("node:sqlite")
      .then((mod) => (typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null))
      .catch(() => null);
  }
  return sqliteModulePromise;
}

function probeFts5(DatabaseSync) {
  if (process.env.PURGE_MEMORY_NO_FTS5 === "1") return false;
  if (!DatabaseSync) return false;
  if (cachedNativeFts5 !== null) return cachedNativeFts5;
  try {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE __purge_fts5_probe USING fts5(x)");
      cachedNativeFts5 = true;
    } finally {
      db.close();
    }
  } catch {
    cachedNativeFts5 = false;
  }
  return cachedNativeFts5;
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function makeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function readSessionEvents(session) {
  if (!session) return null;
  if (typeof session.snapshotEvents === "function") {
    const snap = session.snapshotEvents();
    if (Array.isArray(snap)) return snap;
  }
  if (Array.isArray(session.log)) return session.log;
  if (Array.isArray(session.events)) return session.events;
  return null;
}

function resolveSessionIdentity(agent, fallbackHome = "") {
  const session = agent?.session;
  if (!session) return null;
  const sessionId = typeof session?.header?.id === "string" && session.header.id.trim()
    ? session.header.id.trim()
    : typeof session?.id === "string" && session.id.trim()
      ? session.id.trim()
      : typeof agent?.id === "string" && agent.id.trim()
        ? agent.id.trim()
        : "";
  const rawCwd = typeof session?.header?.cwd === "string" ? session.header.cwd.trim() : "";
  if (!sessionId || !rawCwd || !path.isAbsolute(rawCwd)) return null;
  if (!readSessionEvents(session)) return null;
  return {
    session,
    sessionId,
    workspace: path.resolve(rawCwd),
    dshHome: fallbackHome,
  };
}

export function memoryRootDir(dshHome) {
  return path.join(String(dshHome || ""), "dsh-purge", "memory");
}

export function memoryDbPath({ root, dshHome, sessionId, workspace }) {
  const resolvedWorkspace = path.resolve(String(workspace));
  const idHash = sha256Hex(canonicalJson({ sessionId: String(sessionId), workspace: resolvedWorkspace }));
  const baseDir = root ? String(root) : memoryRootDir(dshHome);
  return {
    baseDir,
    dbPath: path.join(baseDir, `${idHash}.sqlite`),
    resolvedWorkspace,
  };
}

/**
 * Slice a JS string along UTF-16 code-unit boundaries without splitting surrogate pairs.
 *
 * @param {string} text
 * @param {number} [offset=0]
 * @param {number} [limit=MEMORY_LIMITS.defaultReadLimit]
 * @param {number} [maxLimit=MEMORY_LIMITS.maxReadLimit]
 */
export function sliceUtf16Safe(
  text,
  offset = 0,
  limit = MEMORY_LIMITS.defaultReadLimit,
  maxLimit = MEMORY_LIMITS.maxReadLimit,
) {
  const str = String(text ?? "");
  const start = offset === undefined ? 0 : offset;
  if (!Number.isSafeInteger(start) || start < 0 || start > str.length) {
    throw makeError("INVALID_ARGUMENT", `offset ${JSON.stringify(offset)} out of range [0, ${str.length}]`);
  }
  if (start > 0 && start < str.length) {
    const curr = str.charCodeAt(start);
    const prev = str.charCodeAt(start - 1);
    if (curr >= 0xdc00 && curr <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) {
      throw makeError("INVALID_ARGUMENT", "offset splits a UTF-16 surrogate pair");
    }
  }
  const rawLimit = limit === undefined ? MEMORY_LIMITS.defaultReadLimit : limit;
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) {
    throw makeError("INVALID_ARGUMENT", "limit must be a positive safe integer");
  }
  const size = Math.min(rawLimit, maxLimit);
  let end = Math.min(str.length, start + size);
  if (end < str.length && end > start) {
    const tail = str.charCodeAt(end - 1);
    const next = str.charCodeAt(end);
    if (tail >= 0xd800 && tail <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end -= 1;
    }
    if (end === start) {
      throw makeError("INVALID_ARGUMENT", "limit is too small to fit a surrogate pair");
    }
  }
  return {
    text: str.slice(start, end),
    offset: start,
    nextOffset: end < str.length ? end : null,
    totalChars: str.length,
    complete: end === str.length,
  };
}

/**
 * Quote search tokens for FTS5 MATCH so punctuation (IPs, flags, URLs, colons)
 * cannot trigger FTS5 operator syntax errors.
 *
 * @param {string} query
 * @returns {string}
 */
export function escapeFts5Query(query) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return "";
  return tokens.map((tok) => `"${tok}"`).join(" ");
}

function tokenizeQuery(query) {
  const clean = String(query ?? "").replace(/[\x00-\x1f\x7f"]/g, " ").trim();
  if (!clean) return [];
  return clean.split(/\s+/).filter(Boolean).slice(0, 16);
}

function previewText(text, maxChars = MEMORY_LIMITS.previewChars) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${sliceUtf16Safe(compact, 0, maxChars - 1, maxChars).text}…`;
}

function collectTextParts(node, out, depth = 0) {
  if (node == null || depth > 24) return;
  if (typeof node === "string") {
    const s = node.trim();
    if (s) out.push(s);
    return;
  }
  if (typeof node === "number" || typeof node === "boolean") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectTextParts(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    if (typeof node.text === "string" && node.text.trim()) out.push(node.text.trim());
    if (typeof node.name === "string" && node.name.trim()) out.push(node.name.trim());
    if (typeof node.toolName === "string" && node.toolName.trim()) out.push(node.toolName.trim());
    if (node.content !== undefined) collectTextParts(node.content, out, depth + 1);
    if (node.message !== undefined) collectTextParts(node.message, out, depth + 1);
    if (node.arguments !== undefined) collectTextParts(node.arguments, out, depth + 1);
    if (node.input !== undefined) collectTextParts(node.input, out, depth + 1);
    if (node.output !== undefined) collectTextParts(node.output, out, depth + 1);
    if (node.result !== undefined) collectTextParts(node.result, out, depth + 1);
    if (node.summary !== undefined) collectTextParts(node.summary, out, depth + 1);
  }
}

function extractSearchText(event) {
  const parts = [];
  collectTextParts(event?.data, parts, 0);
  if (parts.length > 0) return parts.join("\n");
  return canonicalJson(event?.data ?? null);
}

function extractSummaryText(summaryData) {
  if (typeof summaryData === "string") return summaryData;
  if (Array.isArray(summaryData)) {
    const parts = [];
    for (const block of summaryData) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block.text === "string") parts.push(block.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return canonicalJson(summaryData ?? "");
}

function shouldSkipEvent(event) {
  if (!event || typeof event !== "object") return true;
  if (!TRACKED_EVENT_TYPES.has(event.type)) return true;
  const srcKind = event?.data?.source?.kind ?? event?.data?.message?.source?.kind ?? event?.data?.plugin;
  if (typeof srcKind === "string" && SKIP_SOURCE_KINDS.has(srcKind)) return true;
  return false;
}

function resolveEventTimestamp(event) {
  if (typeof event?.timestamp === "string" && event.timestamp.trim()) {
    return event.timestamp;
  }
  if (typeof event?.time === "number" && Number.isFinite(event.time)) {
    return new Date(event.time).toISOString();
  }
  if (typeof event?.time === "string" && event.time.trim()) {
    const parsed = Date.parse(event.time);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : event.time.trim();
  }
  return null;
}

export class SessionMemoryStore {
  constructor({ db, dbPath, sessionId, workspace, fts5, limits = MEMORY_LIMITS }) {
    this.db = db;
    this.dbPath = dbPath;
    this.sessionId = sessionId;
    this.workspace = workspace;
    this.fts5 = fts5;
    this.limits = limits;
    this.closed = false;
    this.cachedState = this.#loadState();
  }

  static async open({ root, dshHome, sessionId, workspace, limits = MEMORY_LIMITS }) {
    if (typeof sessionId !== "string" || !sessionId.trim() || typeof workspace !== "string" || !path.isAbsolute(workspace)) {
      throw makeError("MEMORY_SCOPE_REQUIRED", "Session memory requires a valid sessionId and absolute workspace");
    }
    const DatabaseSync = await loadSqlite();
    if (!DatabaseSync) {
      throw makeError("SQLITE_UNAVAILABLE", "node:sqlite DatabaseSync is unavailable in this Node runtime");
    }
    const { baseDir, dbPath, resolvedWorkspace } = memoryDbPath({ root, dshHome, sessionId, workspace });
    fs.mkdirSync(baseDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    let fts5 = false;
    try {
      db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_meta (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          session_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          total_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS archived_events (
          seq INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          body TEXT NOT NULL,
          search_text TEXT NOT NULL,
          byte_len INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_archived_events_type ON archived_events(type);
        CREATE TABLE IF NOT EXISTS compaction_nodes (
          summary_seq INTEGER PRIMARY KEY,
          compaction_id TEXT,
          sha256 TEXT NOT NULL,
          summary_text TEXT NOT NULL,
          shadowed_seqs TEXT NOT NULL,
          range_start INTEGER,
          range_end INTEGER,
          created_at TEXT NOT NULL
        );
      `);
      fts5 = probeFts5(DatabaseSync);
      if (fts5) {
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(seq UNINDEXED, type UNINDEXED, search_text);");
      }
      db.prepare("INSERT OR IGNORE INTO memory_meta(id, session_id, workspace, total_bytes) VALUES(1, ?, ?, 0)")
        .run(sessionId, resolvedWorkspace);
      const meta = db.prepare("SELECT session_id, workspace FROM memory_meta WHERE id = 1").get();
      if (!meta || meta.session_id !== sessionId || meta.workspace !== resolvedWorkspace) {
        throw makeError("MEMORY_SCOPE_MISMATCH", "Stored archive belongs to a different session or workspace");
      }
      return new SessionMemoryStore({ db, dbPath, sessionId, workspace: resolvedWorkspace, fts5, limits });
    } catch (error) {
      try { db.close(); } catch { /* ignore */ }
      throw error;
    }
  }

  #assertOpen() {
    if (this.closed) throw makeError("MEMORY_CLOSED", "Session memory store is closed");
  }

  #loadState() {
    const meta = this.db.prepare("SELECT total_bytes FROM memory_meta WHERE id = 1").get();
    const counts = this.db.prepare("SELECT COUNT(*) AS n FROM archived_events").get();
    const sumCount = this.db.prepare("SELECT COUNT(*) AS n FROM compaction_nodes").get();
    const latest = this.db.prepare("SELECT summary_seq, sha256 FROM compaction_nodes ORDER BY summary_seq DESC LIMIT 1").get();
    return {
      totalBytes: Number(meta?.total_bytes || 0),
      archivedEvents: Number(counts?.n || 0),
      summaryCount: Number(sumCount?.n || 0),
      latestSummary: latest ? { kind: "summary", seq: Number(latest.summary_seq), sha256: String(latest.sha256) } : null,
    };
  }

  status() {
    this.#assertOpen();
    this.cachedState = this.#loadState();
    return { ...this.cachedState, fts5: this.fts5 };
  }

  cachedSummaryState() {
    return this.cachedState;
  }

  capture(event, fallbackSeq) {
    this.#assertOpen();
    if (shouldSkipEvent(event)) return { captured: false, skipped: true };
    const seq = Number.isSafeInteger(event.seq) ? event.seq : fallbackSeq;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw makeError("INVALID_EVENT_SEQ", "Event missing valid integer seq");
    }

    const resolvedIso = resolveEventTimestamp(event);
    const rawTime = typeof event?.time === "number" && Number.isFinite(event.time) ? event.time : null;
    const body = canonicalJson({
      seq,
      type: event.type,
      time: rawTime,
      timestamp: resolvedIso,
      data: event.data ?? null,
    });
    const byteLen = Buffer.byteLength(body, "utf8");
    if (byteLen > this.limits.maxEventBytes) {
      throw makeError("EVENT_TOO_LARGE", `Event ${seq} (${byteLen} B) exceeds maxEventBytes`);
    }
    const digest = sha256Hex(body);
    const existing = this.db.prepare("SELECT sha256 FROM archived_events WHERE seq = ?").get(seq);
    if (existing) {
      if (existing.sha256 === digest) return { captured: false, duplicate: true, seq };
      throw makeError("MEMORY_EVENT_CONFLICT", `Event ${seq} payload differs from previously committed archive`);
    }
    const meta = this.db.prepare("SELECT total_bytes FROM memory_meta WHERE id = 1").get();
    const currentTotal = Number(meta?.total_bytes || 0);
    if (currentTotal + byteLen > this.limits.maxSessionBytes) {
      throw makeError("SESSION_QUOTA_EXCEEDED", `Session memory quota (${this.limits.maxSessionBytes} B) exceeded`);
    }

    const searchText = extractSearchText(event);
    const createdAt = resolvedIso || new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT INTO archived_events(seq, type, sha256, body, search_text, byte_len, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      ).run(seq, event.type, digest, body, searchText, byteLen, createdAt);
      this.db.prepare("UPDATE memory_meta SET total_bytes = total_bytes + ? WHERE id = 1").run(byteLen);
      if (this.fts5) {
        try {
          this.db.prepare("INSERT INTO events_fts(seq, type, search_text) VALUES(?, ?, ?)").run(seq, event.type, searchText);
        } catch {
          // Graceful fallback if table missing or runtime disabled
        }
      }
      if (event.type === "compaction/summary") {
        const d = event.data || {};
        const summaryText = extractSummaryText(d.summary ?? "");
        const summaryHash = sha256Hex(summaryText);
        const shadowedSeqs = Array.isArray(d.shadowedSeqs)
          ? d.shadowedSeqs.filter((n) => Number.isSafeInteger(n))
          : [];
        const rangeStart = Number.isSafeInteger(d.shadowedRange?.start) ? d.shadowedRange.start : null;
        const rangeEnd = Number.isSafeInteger(d.shadowedRange?.end) ? d.shadowedRange.end : null;
        this.db.prepare(
          `INSERT OR IGNORE INTO compaction_nodes(summary_seq, compaction_id, sha256, summary_text, shadowed_seqs, range_start, range_end, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          seq,
          d.compactionId === undefined || d.compactionId === null ? null : String(d.compactionId),
          summaryHash,
          summaryText,
          JSON.stringify(shadowedSeqs),
          rangeStart,
          rangeEnd,
          createdAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }

    this.cachedState = this.#loadState();
    return { captured: true, seq, sha256: digest };
  }

  restore() {
    this.#assertOpen();
    this.cachedState = this.#loadState();
    const summaries = this.db.prepare(
      "SELECT summary_seq, compaction_id, sha256, summary_text, range_start, range_end, created_at FROM compaction_nodes ORDER BY summary_seq DESC LIMIT 8",
    ).all().map((row) => ({
      ref: { kind: "summary", seq: Number(row.summary_seq), sha256: String(row.sha256) },
      compactionId: row.compaction_id,
      rangeStart: row.range_start,
      rangeEnd: row.range_end,
      preview: previewText(row.summary_text),
      createdAt: row.created_at,
    }));
    const recentEvents = this.db.prepare(
      "SELECT seq, type, sha256, search_text, created_at FROM archived_events ORDER BY seq DESC LIMIT 12",
    ).all().map((row) => ({
      ref: { kind: "event", seq: Number(row.seq), sha256: String(row.sha256) },
      type: row.type,
      preview: previewText(row.search_text),
      createdAt: row.created_at,
    }));
    return {
      latestSummary: this.cachedState.latestSummary,
      summaries,
      recentEvents,
      archivedEvents: this.cachedState.archivedEvents,
      totalBytes: this.cachedState.totalBytes,
    };
  }

  search(query, limit = this.limits.defaultSearchLimit) {
    this.#assertOpen();
    if (typeof query !== "string" || query.length > 256) {
      throw makeError("INVALID_ARGUMENT", "query must be a string up to 256 characters");
    }
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) throw makeError("INVALID_ARGUMENT", "search requires a non-empty query");
    const safeLimit = !Number.isSafeInteger(limit) ? this.limits.defaultSearchLimit : Math.max(1, Math.min(limit, this.limits.maxSearchLimit));

    const useFts5 = probeFts5(this.db.constructor) && this.fts5 && (() => {
      try {
        const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events_fts'").get();
        return Boolean(row);
      } catch {
        return false;
      }
    })();

    let rows = [];
    let mode = "like";
    if (useFts5) {
      const ftsQuery = escapeFts5Query(query);
      if (ftsQuery) {
        try {
          rows = this.db.prepare(
            `SELECT e.seq, e.type, e.sha256, e.search_text, e.created_at
             FROM events_fts f
             JOIN archived_events e ON e.seq = CAST(f.seq AS INTEGER)
             WHERE events_fts MATCH ?
             ORDER BY e.seq DESC
             LIMIT ?`,
          ).all(ftsQuery, safeLimit);
          mode = "fts5";
        } catch {
          mode = "like";
        }
      }
    }
    if (mode === "like") {
      const clauses = tokens.map(() => "search_text LIKE ? ESCAPE '\\'").join(" AND ");
      const params = tokens.map((tok) => `%${tok.replace(/[\\%_]/g, "\\$&")}%`);
      rows = this.db.prepare(
        `SELECT seq, type, sha256, search_text, created_at
         FROM archived_events
         WHERE ${clauses}
         ORDER BY seq DESC
         LIMIT ?`,
      ).all(...params, safeLimit);
    }

    return {
      query: String(query),
      mode,
      count: rows.length,
      items: rows.map((r) => ({
        ref: { kind: "event", seq: Number(r.seq), sha256: String(r.sha256) },
        type: r.type,
        preview: previewText(r.search_text),
        createdAt: r.created_at,
      })),
    };
  }

  read(ref, offset = 0, limit = this.limits.defaultReadLimit) {
    this.#assertOpen();
    if (
      !ref
      || typeof ref !== "object"
      || !["event", "summary"].includes(ref.kind)
      || !Number.isSafeInteger(ref.seq)
      || ref.seq < 0
      || typeof ref.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(ref.sha256)
    ) {
      throw makeError("INVALID_ARGUMENT", "read requires ref={ kind: 'event'|'summary', seq>=0, sha256 }");
    }
    let content;
    let storedHash;
    if (ref.kind === "summary") {
      const row = this.db.prepare("SELECT sha256, summary_text FROM compaction_nodes WHERE summary_seq = ?").get(ref.seq);
      if (!row) throw makeError("NOT_FOUND", `Summary ref ${ref.seq} not found`);
      storedHash = String(row.sha256);
      content = String(row.summary_text);
    } else {
      const row = this.db.prepare("SELECT sha256, body FROM archived_events WHERE seq = ?").get(ref.seq);
      if (!row) throw makeError("NOT_FOUND", `Event ref ${ref.seq} not found`);
      storedHash = String(row.sha256);
      content = String(row.body);
    }
    if (storedHash !== ref.sha256) {
      throw makeError("HASH_MISMATCH", `Ref ${ref.kind}:${ref.seq} sha256 mismatch (expected ${ref.sha256}, stored ${storedHash})`);
    }
    const page = sliceUtf16Safe(content, offset, limit, this.limits.maxReadLimit);
    return { ref, ...page };
  }

  expand(ref, offset = 0, limit = this.limits.defaultExpandLimit) {
    this.#assertOpen();
    if (
      !ref
      || typeof ref !== "object"
      || ref.kind !== "summary"
      || !Number.isSafeInteger(ref.seq)
      || ref.seq < 0
      || typeof ref.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(ref.sha256)
    ) {
      throw makeError("INVALID_ARGUMENT", "expand requires ref={ kind: 'summary', seq>=0, sha256 }");
    }
    const node = this.db.prepare(
      "SELECT summary_seq, compaction_id, sha256, summary_text, shadowed_seqs, range_start, range_end FROM compaction_nodes WHERE summary_seq = ?",
    ).get(ref.seq);
    if (!node) throw makeError("NOT_FOUND", `Summary ref ${ref.seq} not found`);
    if (String(node.sha256) !== ref.sha256) {
      throw makeError("HASH_MISMATCH", `Summary ref ${ref.seq} sha256 mismatch`);
    }
    let seqs = [];
    try { seqs = JSON.parse(node.shadowed_seqs); } catch { seqs = []; }
    if (!Array.isArray(seqs)) seqs = [];

    const start = offset === undefined ? 0 : offset;
    if (!Number.isSafeInteger(start) || start < 0 || start > seqs.length) {
      throw makeError("INVALID_ARGUMENT", `expand offset out of range [0, ${seqs.length}]`);
    }
    const rawLimit = limit === undefined ? this.limits.defaultExpandLimit : limit;
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) {
      throw makeError("INVALID_ARGUMENT", "expand limit must be positive integer");
    }
    const size = Math.min(rawLimit, this.limits.maxExpandLimit);
    const slice = seqs.slice(start, start + size);

    const bySeq = new Map();
    if (slice.length > 0) {
      const placeholders = slice.map(() => "?").join(",");
      const found = this.db.prepare(
        `SELECT seq, type, sha256, search_text, created_at FROM archived_events WHERE seq IN (${placeholders})`,
      ).all(...slice);
      for (const row of found) bySeq.set(Number(row.seq), row);
    }

    const items = [];
    const missingSeqs = [];
    for (const seq of slice) {
      const row = bySeq.get(seq);
      if (!row) {
        missingSeqs.push(seq);
        continue;
      }
      items.push({
        ref: { kind: "event", seq: Number(row.seq), sha256: String(row.sha256) },
        type: row.type,
        preview: previewText(row.search_text),
        createdAt: row.created_at,
      });
    }
    const nextOffset = start + slice.length < seqs.length ? start + slice.length : null;
    return {
      ref,
      compactionId: node.compaction_id,
      summaryText: node.summary_text,
      shadowedCount: seqs.length,
      missingSeqs,
      offset: start,
      nextOffset,
      totalItems: seqs.length,
      complete: nextOffset === null,
      items,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } catch { /* ignore */ }
  }
}

export const MEMORY_TOOL_SPEC = Object.freeze({
  name: "purge_memory",
  description:
    "检索和恢复被上下文压缩归档的历史消息与工具输出（按需懒启用，不改动压缩器）。动作：status 查归档状态；restore 取最近摘要与事件引用；search 按关键词检索；read 按 {kind,seq,sha256} 分页读取原文；expand 展开某次压缩覆盖的原事件序列。",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["status", "restore", "search", "read", "expand"],
        description: "操作：status | restore | search | read | expand",
      },
      query: { type: "string", description: "search 检索关键词（非空，最长 256 字符）" },
      ref: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "seq", "sha256"],
        properties: {
          kind: { type: "string", enum: ["event", "summary"] },
          seq: { type: "integer", description: "事件或摘要序号 seq（非负整数）" },
          sha256: { type: "string", description: "64 位小写 SHA-256 十六进制摘要" },
        },
        description: "read / expand 目标引用（来自 restore / search / 导航提示）",
      },
      offset: { type: "integer", description: "分页起始偏移（>=0；read 为 UTF-16 单元，expand 为条目下标）" },
      limit: { type: "integer", description: "本页条数或字符上限（1-4096）" },
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" } },
    },
    render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
  },
});

export function installSessionMemory(ctx, options = {}) {
  const enabled = options.enabled !== false;
  const rootOption = options.root;
  const resolveHome = typeof options.dshHome === "function" ? options.dshHome : () => String(options.dshHome || "");
  const limits = options.limits || MEMORY_LIMITS;

  const entries = new Map();
  const agentBySession = new Map();
  const pendingCompactedSessions = new WeakSet();
  const listeners = [];
  let closed = false;

  const listen = (name, handler) => {
    if (typeof ctx?.on !== "function") return;
    try {
      const dispose = ctx.on(name, handler, { global: true });
      if (typeof dispose === "function") listeners.push(dispose);
    } catch { /* ignore unsupported event */ }
  };

  function resolveDbLoc(identity) {
    return memoryDbPath({
      root: rootOption,
      dshHome: identity.dshHome,
      sessionId: identity.sessionId,
      workspace: identity.workspace,
    });
  }

  function hasExistingDbOnDisk(identity) {
    if (!identity) return false;
    try {
      const { dbPath } = resolveDbLoc(identity);
      return fs.existsSync(dbPath);
    } catch {
      return false;
    }
  }

  function queue(entry, fn) {
    const job = entry.tail.then(fn);
    entry.tail = job.catch(() => {});
    return job;
  }

  async function syncChunk(entry, drainAll = false) {
    if (entry.disposed || entry.error) return;
    try {
      const identity = resolveSessionIdentity(entry.agent, resolveHome());
      if (!identity || identity.session !== entry.session || identity.sessionId !== entry.sessionId || identity.workspace !== entry.workspace) {
        entry.error = { code: "MEMORY_SCOPE_CHANGED", message: "Session or workspace identity changed" };
        return;
      }
      if (!entry.store) {
        entry.store = await SessionMemoryStore.open({
          root: rootOption,
          dshHome: identity.dshHome,
          sessionId: entry.sessionId,
          workspace: entry.workspace,
          limits,
        });
      }
      const events = readSessionEvents(entry.session) || [];
      while (entry.cursor < events.length) {
        let batch = 0;
        const started = performance.now();
        while (
          entry.cursor < events.length
          && batch < limits.pumpBatchEvents
          && (batch === 0 || performance.now() - started < limits.pumpBatchMs)
        ) {
          const idx = entry.cursor;
          entry.cursor += 1;
          batch += 1;
          entry.store.capture(events[idx], idx);
        }
        if (!drainAll || entry.cursor >= events.length) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      if (!entry.error) {
        entry.error = {
          code: error?.code || "MEMORY_UNAVAILABLE",
          message: String(error?.message || error).slice(0, 400),
        };
      }
    }
  }

  function schedulePump(entry) {
    if (closed || entry.closing || entry.disposed || entry.error || entry.scheduled) return;
    entry.scheduled = setImmediate(() => {
      entry.scheduled = null;
      queue(entry, () => syncChunk(entry, false))
        .catch(() => {})
        .finally(() => {
          const events = readSessionEvents(entry.session);
          if (!entry.closing && !entry.disposed && !entry.error && events && entry.cursor < events.length) {
            schedulePump(entry);
          }
        });
    });
  }

  function navigationText(entry) {
    if (closed || !entry || entry.disposed) return "";
    if (entry.error) {
      return `[dsh-purge:session-memory]\nArchive error (${entry.error.code}). Check purge_memory(action="status") before relying on compacted history.`;
    }
    const state = entry.store?.cachedSummaryState();
    if (!state || state.summaryCount === 0 || !state.latestSummary) return "";
    return [
      "[dsh-purge:session-memory]",
      `Earlier turns were compacted and losslessly archived (latest=${state.latestSummary.seq}:${state.latestSummary.sha256.slice(0, 12)}).`,
      `Use purge_memory(action="expand", ref=${JSON.stringify(state.latestSummary)}) or action="search"/"read"/"restore" to recover exact prior messages/tool outputs.`,
    ].join("\n");
  }

  async function activate(agent, { drainAll = false } = {}) {
    if (!enabled || closed) return null;
    const identity = resolveSessionIdentity(agent, resolveHome());
    if (!identity) return null;
    agentBySession.set(identity.session, agent);

    let entry = entries.get(agent);
    if (entry?.closing) return null;
    if (entry && (entry.session !== identity.session || entry.sessionId !== identity.sessionId || entry.workspace !== identity.workspace)) {
      entry.error = { code: "MEMORY_SCOPE_CHANGED", message: "Session or workspace identity changed" };
      return entry;
    }
    if (!entry) {
      if (entries.size >= limits.maxActiveSessions) return null;
      entry = {
        agent,
        session: identity.session,
        sessionId: identity.sessionId,
        workspace: identity.workspace,
        cursor: 0,
        tail: Promise.resolve(),
        store: null,
        error: null,
        scheduled: null,
        disposed: false,
        closing: false,
        releasePromise: null,
        contextDispose: null,
      };
      entries.set(agent, entry);
      const prompt = agent.ctx?.get?.("systemPrompt");
      if (typeof prompt?.context === "function") {
        try {
          entry.contextDispose = prompt.context({
            name: "dsh-purge:session-memory",
            order: 85,
            required: true,
            interpolate: false,
            text: () => navigationText(entry),
          });
        } catch { /* ignore if host lacks scoped systemPrompt */ }
      }
    }

    await queue(entry, () => syncChunk(entry, drainAll)).catch(() => {});
    const events = readSessionEvents(entry.session);
    if (!drainAll && events && entry.cursor < events.length && !entry.error) {
      schedulePump(entry);
    }
    return entry;
  }

  async function releaseAgent(agent) {
    const entry = entries.get(agent);
    if (!entry) return;
    if (entry.releasePromise) return entry.releasePromise;
    entry.closing = true;
    if (entry.scheduled) {
      clearImmediate(entry.scheduled);
      entry.scheduled = null;
    }
    if (typeof entry.contextDispose === "function") {
      try { entry.contextDispose(); } catch { /* ignore */ }
      entry.contextDispose = null;
    }
    entry.releasePromise = (async () => {
      try {
        await queue(entry, () => syncChunk(entry, true)).catch(() => {});
      } finally {
        entry.disposed = true;
        entry.store?.close();
        entries.delete(agent);
        agentBySession.delete(entry.session);
      }
    })();
    return entry.releasePromise;
  }

  function considerAgentEvent(agent) {
    if (!enabled || closed || !agent) return;
    const identity = resolveSessionIdentity(agent, resolveHome());
    if (!identity) return;
    agentBySession.set(identity.session, agent);
    if (entries.has(agent)) return;
    if (pendingCompactedSessions.has(identity.session) || hasExistingDbOnDisk(identity)) {
      pendingCompactedSessions.delete(identity.session);
      activate(agent).catch(() => {});
    }
  }

  listen("agent/created", ({ agent }) => considerAgentEvent(agent));
  listen("agent/pre-step", async ({ agent }, next) => {
    considerAgentEvent(agent);
    return typeof next === "function" ? next() : undefined;
  });
  listen("session/event", (session, event) => {
    if (!enabled || closed || !session) return;
    if (event?.type === "compaction/summary" || event?.type === "compaction/end") {
      const agent = agentBySession.get(session);
      if (agent) {
        activate(agent).catch(() => {});
      } else {
        pendingCompactedSessions.add(session);
      }
      return;
    }
    const agent = agentBySession.get(session);
    const entry = agent ? entries.get(agent) : null;
    if (entry) schedulePump(entry);
  });
  listen("agent/disposed", ({ agent }) => {
    if (agent) releaseAgent(agent).catch(() => {});
  });

  async function handle(agent, input) {
    if (!input || typeof input !== "object") {
      throw makeError("INVALID_ARGUMENT", "purge_memory requires an arguments object");
    }
    const action = input.action;
    if (!["status", "restore", "search", "read", "expand"].includes(action)) {
      throw makeError("INVALID_ARGUMENT", `Unsupported purge_memory action: ${String(action)}`);
    }

    const identity = resolveSessionIdentity(agent, resolveHome());
    const DatabaseSync = await loadSqlite();
    const fts5 = probeFts5(DatabaseSync);

    if (action === "status") {
      let entry = agent ? entries.get(agent) : null;
      if (!entry && identity && (pendingCompactedSessions.has(identity.session) || hasExistingDbOnDisk(identity))) {
        entry = await activate(agent, { drainAll: true });
      }
      if (!entry) {
        const hostEvents = readSessionEvents(agent?.session)?.length ?? 0;
        return {
          ok: true,
          action: "status",
          enabled,
          active: false,
          available: Boolean(enabled && DatabaseSync),
          fts5,
          archivedEvents: 0,
          hostEvents,
          captureComplete: false,
          totalBytes: 0,
          summaryCount: 0,
          latestSummary: null,
          error: null,
        };
      }
      return queue(entry, () => {
        const st = entry.store ? entry.store.status() : { totalBytes: 0, archivedEvents: 0, summaryCount: 0, latestSummary: null, fts5 };
        const hostEvents = readSessionEvents(entry.session)?.length ?? 0;
        return {
          ok: true,
          action: "status",
          enabled,
          active: true,
          available: Boolean(DatabaseSync) && !entry.error,
          fts5: st.fts5,
          archivedEvents: st.archivedEvents,
          hostEvents,
          captureComplete: !entry.error && entry.cursor >= hostEvents,
          totalBytes: st.totalBytes,
          summaryCount: st.summaryCount,
          latestSummary: st.latestSummary,
          error: entry.error,
        };
      });
    }

    if (!enabled) {
      throw makeError("MEMORY_DISABLED", "Session memory is disabled by configuration");
    }
    if (!DatabaseSync) {
      throw makeError("SQLITE_UNAVAILABLE", "node:sqlite DatabaseSync is unavailable in this Node runtime");
    }
    const entry = await activate(agent, { drainAll: true });
    if (!entry) {
      throw makeError("MEMORY_SCOPE_REQUIRED", "purge_memory requires a valid DSH agent session and workspace");
    }
    if (entry.error) {
      throw makeError(entry.error.code, entry.error.message);
    }
    return queue(entry, () => {
      if (entry.error) throw makeError(entry.error.code, entry.error.message);
      if (!entry.store) throw makeError("MEMORY_UNAVAILABLE", "Session memory store unavailable");
      const hostEvents = readSessionEvents(entry.session)?.length ?? 0;
      const captureComplete = !entry.error && entry.cursor >= hostEvents;
      if (action === "restore") {
        return { ok: true, action: "restore", captureComplete, hostEvents, error: entry.error, ...entry.store.restore() };
      }
      if (action === "search") {
        return { ok: true, action: "search", ...entry.store.search(input.query, input.limit) };
      }
      if (action === "read") {
        return { ok: true, action: "read", ...entry.store.read(input.ref, input.offset, input.limit) };
      }
      return { ok: true, action: "expand", ...entry.store.expand(input.ref, input.offset, input.limit) };
    });
  }

  async function dispose() {
    if (closed) return;
    closed = true;
    for (const off of listeners.splice(0).reverse()) {
      try { off(); } catch { /* ignore */ }
    }
    await Promise.all([...entries.keys()].map((agent) => releaseAgent(agent).catch(() => {})));
    agentBySession.clear();
  }

  return { handle, dispose, toolSpec: MEMORY_TOOL_SPEC };
}
