import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MEMORY_LIMITS,
  MEMORY_TOOL_SPEC,
  SessionMemoryStore,
  escapeFts5Query,
  installSessionMemory,
  memoryDbPath,
  sliceUtf16Safe,
} from "../lib/session-memory.js";

const hasSqlite = await import("node:sqlite")
  .then((m) => typeof m?.DatabaseSync === "function")
  .catch(() => false);

function makeMockHarness(dshHome) {
  const listeners = new Map();
  const listenerOptions = [];
  const ctx = {
    on(name, fn, opts) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      listenerOptions.push({ name, opts });
      return () => {
        const list = listeners.get(name);
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
  };
  const mem = installSessionMemory(ctx, {
    enabled: true,
    dshHome,
  });

  function emit(name, ...args) {
    const list = listeners.get(name) || [];
    for (const fn of list) {
      fn(...args);
    }
  }

  async function emitAsync(name, ...args) {
    const list = listeners.get(name) || [];
    for (const fn of list) {
      await fn(...args);
    }
  }

  return { mem, emit, emitAsync, listenerOptions };
}

function makeMockAgent({ sessionId, cwd, events = [] }) {
  const contexts = [];
  const session = {
    id: sessionId,
    header: { id: sessionId, cwd },
    log: events,
    snapshotEvents() {
      return [...events];
    },
  };
  const agent = {
    id: sessionId,
    session,
    ctx: {
      get(key) {
        if (key === "systemPrompt") {
          return {
            context(spec) {
              contexts.push(spec);
              return () => {};
            },
          };
        }
        return undefined;
      },
    },
  };
  return { agent, session, events, contexts };
}

test("sliceUtf16Safe: ASCII/CJK pagination and surrogate-pair safety", () => {
  const asciiCjk = "Hello世界!测试12345";
  const parts = [];
  let offset = 0;
  while (true) {
    const page = sliceUtf16Safe(asciiCjk, offset, 4, 4);
    parts.push(page.text);
    if (page.complete) {
      assert.equal(page.nextOffset, null);
      break;
    }
    assert.ok(typeof page.nextOffset === "number" && page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(parts.join(""), asciiCjk);

  // "😀" occupies indices [1, 2], "🚀" occupies indices [4, 5]
  const emojiText = "A😀B🚀C";
  // start=0, limit=2 would end inside "😀" -> must back off to end=1 ("A")
  const p1 = sliceUtf16Safe(emojiText, 0, 2, 16);
  assert.equal(p1.text, "A");
  assert.equal(p1.nextOffset, 1);
  assert.equal(p1.complete, false);

  // Starting on low surrogate at index 2 must throw INVALID_ARGUMENT
  assert.throws(
    () => sliceUtf16Safe(emojiText, 2, 2, 16),
    (err) => err?.code === "INVALID_ARGUMENT",
  );

  // limit=1 starting on high surrogate at index 1 cannot fit even one surrogate pair -> throws
  assert.throws(
    () => sliceUtf16Safe(emojiText, 1, 1, 16),
    (err) => err?.code === "INVALID_ARGUMENT",
  );

  // Multi-page reassembly at boundary limit=2 remains completely lossless
  const reassembled = [];
  let pos = 0;
  while (true) {
    const page = sliceUtf16Safe(emojiText, pos, 2, 16);
    reassembled.push(page.text);
    if (page.complete) break;
    pos = page.nextOffset;
  }
  assert.equal(reassembled.join(""), emojiText);
});

test("escapeFts5Query: safely quotes IPs, URLs, flags, quotes, and empties", () => {
  assert.equal(escapeFts5Query("10.0.0.1:8443"), '"10.0.0.1:8443"');
  assert.equal(escapeFts5Query("https://a.example/x?y=1"), '"https://a.example/x?y=1"');
  assert.equal(escapeFts5Query("--all-ports -sV"), '"--all-ports" "-sV"');
  assert.equal(escapeFts5Query('find "admin" user'), '"find" "admin" "user"');
  assert.equal(escapeFts5Query("   \x00\x01\"\"  "), "");
});

test("MEMORY_TOOL_SPEC defines strict object schemas without unsupported JSON schema keywords", () => {
  assert.equal(MEMORY_TOOL_SPEC.name, "purge_memory");
  assert.equal(MEMORY_TOOL_SPEC.parameters.type, "object");
  assert.equal(MEMORY_TOOL_SPEC.parameters.additionalProperties, false);
  assert.equal(MEMORY_TOOL_SPEC.parameters.properties.ref.type, "object");
  assert.equal(MEMORY_TOOL_SPEC.parameters.properties.ref.additionalProperties, false);
  const forbidden = new Set(["minLength", "maxLength", "minimum", "maximum", "pattern"]);
  const stack = [MEMORY_TOOL_SPEC.parameters];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    for (const k of Object.keys(node)) {
      assert.equal(forbidden.has(k), false, `unexpected keyword ${k}`);
      if (node[k] && typeof node[k] === "object") stack.push(node[k]);
    }
  }
});

test("SessionMemory: lazy activation keeps ordinary short sessions DB-free", { skip: !hasSqlite }, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-mem-lazy-"));
  const { mem, emit, emitAsync } = makeMockHarness(tmpRoot);
  t.after(async () => {
    await mem.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const events = [
    { seq: 0, type: "user/message", timestamp: "2026-01-01T00:00:00Z", data: { text: "hello" } },
    { seq: 1, type: "assistant/message", timestamp: "2026-01-01T00:00:01Z", data: { text: "hi" } },
    { seq: 2, type: "tool/result", timestamp: "2026-01-01T00:00:02Z", data: { toolName: "bash", output: "ok" } },
  ];
  const { agent, session } = makeMockAgent({ sessionId: "sess-lazy", cwd: tmpRoot, events });

  emit("agent/created", { agent });
  await emitAsync("agent/pre-step", { agent }, async () => {});
  for (const ev of events) emit("session/event", session, ev);

  const status = await mem.handle(agent, { action: "status" });
  assert.equal(status.ok, true);
  assert.equal(status.active, false);
  assert.equal(status.archivedEvents, 0);
  assert.equal(status.hostEvents, 3);
  assert.equal(fs.existsSync(path.join(tmpRoot, "dsh-purge", "memory")), false);
});

test("SessionMemory: compaction lifecycle, FTS5/LIKE search, read integrity, expand, and KV-cache stability", { skip: !hasSqlite }, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-mem-life-"));
  const { mem, emit, emitAsync, listenerOptions } = makeMockHarness(tmpRoot);
  t.after(async () => {
    await mem.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  for (const entry of listenerOptions) {
    assert.equal(entry.opts?.global, true, `listener ${entry.name} must subscribe with { global: true }`);
  }

  const dshTimeMs = 1763700000000;
  const expectedDshIso = new Date(dshTimeMs).toISOString();
  const events = [
    {
      seq: 0,
      type: "user/message",
      time: dshTimeMs,
      data: { text: "Check endpoint 10.0.0.1:8443 --all-ports and https://a.example/x?y=1" },
    },
    {
      seq: 1,
      type: "assistant/message",
      timestamp: "2026-01-01T00:00:01Z",
      data: { text: "Scanning target ALPHA-99 A😀B🚀C" },
    },
    {
      seq: 2,
      type: "tool/result",
      timestamp: "2026-01-01T00:00:02Z",
      data: { toolName: "probe", output: "PORT 8443 OPEN banner=TOKEN_XYZ" },
    },
  ];
  const { agent, session, contexts } = makeMockAgent({ sessionId: "sess-comp", cwd: tmpRoot, events });

  emit("agent/created", { agent });
  await emitAsync("agent/pre-step", { agent }, async () => {});
  assert.equal(contexts.length, 0);

  // Trigger compaction/end first to verify registered context has required:true and "" prior to summary
  emit("session/event", session, { seq: 3, type: "compaction/end", data: {} });
  const beforeSummaryStatus = await mem.handle(agent, { action: "status" });
  assert.equal(beforeSummaryStatus.active, true);
  assert.equal(beforeSummaryStatus.summaryCount, 0);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].required, true);
  assert.equal(contexts[0].interpolate, false);
  assert.equal(contexts[0].order, 85);
  assert.equal(contexts[0].text(), "");

  // Push compaction/summary covering [0, 1, 2, 999]
  const summaryEv = {
    seq: 4,
    type: "compaction/summary",
    timestamp: "2026-01-01T00:00:05Z",
    data: {
      compactionId: "cmp-1",
      summary: "Compacted summary with token ALPHA-99",
      shadowedRange: { start: 0, end: 2 },
      shadowedSeqs: [0, 1, 2, 999],
    },
  };
  events.push(summaryEv);
  emit("session/event", session, summaryEv);

  const st1 = await mem.handle(agent, { action: "status" });
  assert.equal(st1.active, true);
  assert.equal(st1.summaryCount, 1);
  assert.equal(st1.latestSummary?.kind, "summary");
  assert.equal(st1.latestSummary?.seq, 4);
  if (process.env.PURGE_MEMORY_NO_FTS5 === "1") {
    assert.equal(st1.fts5, false);
  }

  const navText1 = contexts[0].text();
  assert.match(navText1, /dsh-purge:session-memory/);
  assert.match(navText1, /latest=4:/);

  // KV-cache stability: subsequent ordinary tool/call and tool/result must NOT mutate navText1
  const e5 = {
    seq: 5,
    type: "tool/call",
    timestamp: "2026-01-01T00:00:06Z",
    data: { toolName: "bash", arguments: { cmd: "id" } },
  };
  const e6 = {
    seq: 6,
    type: "tool/result",
    timestamp: "2026-01-01T00:00:07Z",
    data: { toolName: "bash", output: "uid=0(root)" },
  };
  events.push(e5, e6);
  emit("session/event", session, e5);
  emit("session/event", session, e6);
  // Also trigger pump scheduling tick
  await new Promise((r) => setImmediate(r));
  const st2 = await mem.handle(agent, { action: "status" });
  assert.equal(st2.archivedEvents, 6); // 0, 1, 2, 4(summary), 5, 6 (compaction/end skipped)
  assert.equal(contexts[0].text(), navText1);

  // Restore
  const restored = await mem.handle(agent, { action: "restore" });
  assert.equal(restored.ok, true);
  assert.equal(restored.latestSummary.seq, 4);
  assert.equal(restored.summaries.length, 1);
  assert.ok(restored.recentEvents.length >= 4);

  // Search (keyword + punctuation)
  const searchAlpha = await mem.handle(agent, { action: "search", query: "TOKEN_XYZ" });
  assert.equal(searchAlpha.ok, true);
  assert.ok(searchAlpha.count >= 1);
  assert.equal(searchAlpha.items[0].ref.seq, 2);

  const searchPunct = await mem.handle(agent, { action: "search", query: "10.0.0.1:8443 --all-ports" });
  assert.equal(searchPunct.ok, true);
  assert.ok(searchPunct.count >= 1);
  assert.equal(searchPunct.items[0].ref.seq, 0);
  assert.equal(searchPunct.items[0].createdAt, expectedDshIso);
  if (process.env.PURGE_MEMORY_NO_FTS5 === "1") {
    assert.equal(searchPunct.mode, "like");
  }

  // Verify live-DSH event.time preservation in canonical body
  const readZero = await mem.handle(agent, { action: "read", ref: searchPunct.items[0].ref, offset: 0, limit: 2048 });
  assert.equal(readZero.ok, true);
  assert.match(readZero.text, new RegExp(`"time":${dshTimeMs}`));

  // Verify search/read/expand runtime constraints replacing removed schema keywords
  await assert.rejects(
    () => mem.handle(agent, { action: "search", query: "x".repeat(257) }),
    (err) => err?.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    () => mem.handle(agent, { action: "read", ref: { kind: "event", seq: -1, sha256: "a".repeat(64) } }),
    (err) => err?.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    () => mem.handle(agent, { action: "read", ref: { kind: "event", seq: 0, sha256: "not-a-sha" } }),
    (err) => err?.code === "INVALID_ARGUMENT",
  );

  // Read with SHA-256 verification and paging
  const targetRef = searchAlpha.items[0].ref;
  const readPage = await mem.handle(agent, { action: "read", ref: targetRef, offset: 0, limit: 2048 });
  assert.equal(readPage.ok, true);
  assert.match(readPage.text, /TOKEN_XYZ/);
  assert.equal(readPage.complete, true);

  // Wrong sha256 fails with HASH_MISMATCH
  await assert.rejects(
    () =>
      mem.handle(agent, {
        action: "read",
        ref: { kind: "event", seq: targetRef.seq, sha256: "0".repeat(64) },
      }),
    (err) => err?.code === "HASH_MISMATCH",
  );

  // Expand summary lineage and detect missingSeqs
  const expanded = await mem.handle(agent, { action: "expand", ref: st1.latestSummary });
  assert.equal(expanded.ok, true);
  assert.deepEqual(expanded.items.map((it) => it.ref.seq), [0, 1, 2]);
  assert.deepEqual(expanded.missingSeqs, [999]);

  // Second compaction/summary updates KV-cache navigation hint
  const summaryEv2 = {
    seq: 7,
    type: "compaction/summary",
    timestamp: "2026-01-01T00:00:10Z",
    data: {
      compactionId: "cmp-2",
      summary: "Second summary",
      shadowedRange: { start: 4, end: 6 },
      shadowedSeqs: [4, 5, 6],
    },
  };
  events.push(summaryEv2);
  emit("session/event", session, summaryEv2);
  const st3 = await mem.handle(agent, { action: "status" });
  assert.equal(st3.summaryCount, 2);
  const navText2 = contexts[0].text();
  assert.notEqual(navText2, navText1);
  assert.match(navText2, /latest=7:/);
});

test("SessionMemory: isolates archives across (sessionId, workspace)", { skip: !hasSqlite }, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-mem-iso-"));
  const wsA = path.join(tmpRoot, "ws-a");
  const wsB = path.join(tmpRoot, "ws-b");
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  const { mem, emit } = makeMockHarness(tmpRoot);
  t.after(async () => {
    await mem.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const agentA = makeMockAgent({
    sessionId: "shared-id",
    cwd: wsA,
    events: [{ seq: 0, type: "user/message", data: { text: "SECRET_ALPHA" } }],
  });
  const agentB = makeMockAgent({
    sessionId: "shared-id",
    cwd: wsB,
    events: [{ seq: 0, type: "user/message", data: { text: "SECRET_BETA" } }],
  });

  emit("agent/created", { agent: agentA.agent });
  emit("agent/created", { agent: agentB.agent });
  await mem.handle(agentA.agent, { action: "restore" });
  await mem.handle(agentB.agent, { action: "restore" });

  const dbA = memoryDbPath({ dshHome: tmpRoot, sessionId: "shared-id", workspace: wsA }).dbPath;
  const dbB = memoryDbPath({ dshHome: tmpRoot, sessionId: "shared-id", workspace: wsB }).dbPath;
  assert.notEqual(dbA, dbB);
  assert.equal(fs.existsSync(dbA), true);
  assert.equal(fs.existsSync(dbB), true);

  const searchInAForBeta = await mem.handle(agentA.agent, { action: "search", query: "SECRET_BETA" });
  assert.equal(searchInAForBeta.count, 0);
  const searchInBForBeta = await mem.handle(agentB.agent, { action: "search", query: "SECRET_BETA" });
  assert.equal(searchInBForBeta.count, 1);

  assert.ok(SessionMemoryStore);
  assert.ok(MEMORY_LIMITS.maxEventBytes > 0);
});
