import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  allowPluginRequest,
  installWebServer,
  rewriteLiveAssembly,
  trustedHostnames,
} from "../lib/index.js";
import * as revision from "../lib/revision.js";
import { beginApply, getApplyProgress, resetApplyProgress } from "../lib/apply-progress.js";

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

test("trustedHostnames ignores wildcard 0.0.0.0/:: and collects bindHost, env, and hostEntries", () => {
  const prev = process.env.PURGE_TRUSTED_HOSTS;
  try {
    process.env.PURGE_TRUSTED_HOSTS = "env-one.local:8080, https://env-two.lan:43120";
    const ignored = trustedHostnames("0.0.0.0", ["::", "[::]", "box.internal:3000"]);
    assert.equal(ignored.has("0.0.0.0"), false);
    assert.equal(ignored.has("::"), false);
    assert.equal(ignored.has("env-one.local"), true);
    assert.equal(ignored.has("env-two.lan"), true);
    assert.equal(ignored.has("box.internal"), true);

    const bound = trustedHostnames("192.168.1.55:43120");
    assert.equal(bound.has("192.168.1.55"), true);
  } finally {
    if (prev === undefined) delete process.env.PURGE_TRUSTED_HOSTS;
    else process.env.PURGE_TRUSTED_HOSTS = prev;
  }
});

test("allowPluginRequest blocks DNS rebinding and cross-origin while allowing loopback and trusted hosts", () => {
  // Reject DNS rebinding with or without Origin
  for (const headers of [
    { host: "evil.test:43120" },
    { host: "evil.test:43120", origin: "https://evil.test:43120" },
    { host: "127.0.0.1:43120", origin: "https://evil.test:43120" },
    { host: "127.0.0.1:43120", origin: "null" },
    { host: "127.0.0.1:43120", "sec-fetch-site": "cross-site" },
    {},
  ]) {
    const res = makeRes();
    const ok = allowPluginRequest(makeReq({ headers }), res, trustedHostnames());
    assert.equal(ok, false, `expected block for ${JSON.stringify(headers)}`);
    assert.equal(res.status, 403);
  }

  // Allow loopback IPv4, localhost, IPv6, and ::ffff:127.0.0.1
  for (const headers of [
    { host: "127.0.0.1:43120" },
    { host: "127.0.1.9:43120", origin: "http://127.0.1.9:43120" },
    { host: "localhost:43120", origin: "http://localhost:43120" },
    { host: "dev.localhost:43120", origin: "http://dev.localhost:43120" },
    { host: "[::1]:43120", origin: "http://[::1]:43120" },
    { host: "[::ffff:127.0.0.1]:43120", origin: "http://[::ffff:127.0.0.1]:43120" },
    { host: "[::ffff:7f00:1]:43120", origin: "http://[::ffff:7f00:1]:43120" },
  ]) {
    const res = makeRes();
    const ok = allowPluginRequest(makeReq({ headers }), res, trustedHostnames());
    assert.equal(ok, true, `expected allow for ${JSON.stringify(headers)}`);
    assert.equal(res.status, 0);
  }

  // Allow bindHost, PURGE_TRUSTED_HOSTS, and connection.trustedHosts entries
  const prev = process.env.PURGE_TRUSTED_HOSTS;
  try {
    process.env.PURGE_TRUSTED_HOSTS = "env-panel.test";
    const trusted = trustedHostnames("10.20.30.40", ["conn-panel.test"]);
    for (const host of ["env-panel.test:43120", "10.20.30.40:43120", "conn-panel.test:43120"]) {
      const res = makeRes();
      const ok = allowPluginRequest(
        makeReq({ headers: { host, origin: `http://${host}` } }),
        res,
        trusted,
      );
      assert.equal(ok, true, `expected trusted host ${host} to be allowed`);
    }
  } finally {
    if (prev === undefined) delete process.env.PURGE_TRUSTED_HOSTS;
    else process.env.PURGE_TRUSTED_HOSTS = prev;
  }
});

test("revision CAS helpers track bumps, handle backwards-compatible omitted values, and reset cleanly", () => {
  revision.resetRevForTests();
  assert.equal(revision.currentRev(), 0);
  assert.deepEqual(revision.lastActionInfo(), { action: "", at: 0 });

  for (const omitted of [undefined, null, "", "   ", NaN, "not-a-number", true]) {
    assert.deepEqual(revision.checkRev(omitted), { ok: true, rev: 0, expected: null });
  }

  assert.deepEqual(revision.checkRev(0), { ok: true, rev: 0, expected: 0 });

  const r1 = revision.bumpRev("apply");
  assert.equal(r1, 1);
  assert.equal(revision.currentRev(), 1);
  const info = revision.lastActionInfo();
  assert.equal(info.action, "apply");
  assert.ok(info.at > 0);

  const stale = revision.checkRev(0);
  assert.equal(stale.ok, false);
  assert.equal(stale.rev, 1);
  assert.equal(stale.expected, 0);
  assert.equal(stale.stale, true);
  assert.equal(stale.last.action, "apply");
  assert.match(stale.error, /conflict/i);

  const ahead = revision.checkRev(5);
  assert.equal(ahead.ok, false);
  assert.equal(ahead.stale, false);

  assert.deepEqual(revision.checkRev("1"), { ok: true, rev: 1, expected: 1 });

  revision.resetRevForTests();
  assert.equal(revision.currentRev(), 0);
  assert.equal(revision.lastActionInfo().action, "");
});

test("installWebServer wires host allowlist across all routes and enforces 409 CAS before apply/revert", async () => {
  revision.resetRevForTests();
  resetApplyProgress();
  const routes = [];
  const webServer = {
    host: "0.0.0.0",
    register(spec) {
      routes.push(spec);
      return () => {};
    },
  };
  const ctx = {
    get(name) {
      if (name === "connection") return { trustedHosts: ["trusted.lan"] };
      return null;
    },
    inject(deps, fn) {
      if (deps.includes("webServer")) {
        fn({
          webServer,
          effect(cb) { cb(); },
          get: (name) => ctx.get(name),
        });
      }
      if (deps.includes("connection")) {
        fn({ get: (name) => ctx.get(name) });
      }
    },
  };

  installWebServer(ctx, { enabled: true });

  const findRoute = (p) => routes.find((r) => r.path === p);
  for (const p of ["/dsh-purge/status", "/dsh-purge/apply", "/dsh-purge/revert", "/dsh-purge/rules", "/dsh-purge/skills"]) {
    const route = findRoute(p);
    assert.ok(route, `missing route ${p}`);
    const evilRes = makeRes();
    await route.handler(makeReq({ method: p === "/dsh-purge/status" ? "GET" : "POST", url: p, headers: { host: "evil.test:43120", origin: "https://evil.test:43120" } }), evilRes);
    assert.equal(evilRes.status, 403, `route ${p} must reject untrusted Host`);
  }

  // Status allows trusted.lan and exposes rev + last_action (even while active progress is shown)
  revision.bumpRev("apply");
  beginApply("home");
  try {
    const statusRes = makeRes();
    await findRoute("/dsh-purge/status").handler(
      makeReq({ method: "GET", url: "/dsh-purge/status", headers: { host: "trusted.lan:43120" } }),
      statusRes,
    );
    assert.equal(statusRes.status, 200);
    const statusJson = JSON.parse(statusRes.body);
    assert.equal(statusJson.rev, 1);
    assert.equal(statusJson.last_action.action, "apply");
  } finally {
    resetApplyProgress();
  }

  // Apply & Revert reject stale expectedRev with 409 BEFORE touching apply-progress
  for (const p of ["/dsh-purge/apply", "/dsh-purge/revert"]) {
    const res = makeRes();
    await findRoute(p).handler(
      makeReq({
        method: "POST",
        url: p,
        headers: { host: "trusted.lan:43120", origin: "http://trusted.lan:43120" },
        body: JSON.stringify({ expectedRev: 0 }),
      }),
      res,
    );
    assert.equal(res.status, 409, `${p} must return 409 on stale expectedRev`);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.conflict, true);
    assert.equal(body.stale, true);
    assert.equal(body.rev, 1);
    assert.equal(getApplyProgress().active, false, `${p} must not leave beginApply/beginJob active on 409`);
  }

  revision.resetRevForTests();
});

test("rewriteLiveAssembly short-circuits untouched when config.enabled === false", () => {
  const assembled = {
    sections: [
      { name: "safety-guidelines", content: "I must refuse harmful requests and apologize if unsafe." },
      { name: "system-identity", content: "You are a coding agent powered by DeepSeek." },
      { name: "mnemon-plugin", content: "Mnemon memory" },
    ],
  };
  const snapshot = JSON.stringify(assembled);
  const out = rewriteLiveAssembly({ enabled: false, stripMnemon: true, capabilityProtocol: true }, assembled, {});
  assert.equal(out, assembled, "must return exact same object reference when disabled");
  assert.equal(JSON.stringify(out), snapshot, "sections must remain completely untouched");
  assert.equal(
    out.sections.some((s) => s.name === "dsh-purge" || s.name === "dshpg-anchor" || s.name === "dsh-purge-boost"),
    false,
  );
});
