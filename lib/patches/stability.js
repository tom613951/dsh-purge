function treeBudgetPatch(id, file, moduleName, budget) {
  const isClient = moduleName === "client.js";
  const indent = isClient ? "\t\t\t\t\t" : "\t\t\t";
  const reserveMarker = "/* [dsh-purge] reserve inspector record overhead */";
  const dropMarker = "/* [dsh-purge] discard oversized Cordis tree */";
  return {
    id,
    name: isClient
      ? "INSPECTOR_FRAME_BUDGET_RECORD_OVERHEAD_CLIENT"
      : "INSPECTOR_FRAME_BUDGET_RECORD_OVERHEAD",
    layer: "代码",
    layer_en: "Code",
    desc: isClient
      ? "inspector 客户端预留帧头冗余并丢弃超大 Cordis tree / reserve client inspector frame overhead and drop oversized cordis/tree"
      : "inspector 服务端预留帧头冗余并丢弃超大 Cordis tree / reserve inspector frame overhead and drop oversized cordis/tree",
    file,
    rel: ["lib", moduleName],
    optional: true,
    skipIfMarked: true,
    replacements: [
      {
        pattern: "maxBytes: " + budget + " - 4096\n",
        replace: "maxBytes: " + budget + " - 4096 - 1024 " + reserveMarker + "\n",
        expect: 1,
      },
      {
        pattern:
          "else this.state.set(topic, previous);\n" +
          indent +
          'throw new Error("inspector: source state exceeds the source-frame byte limit");',
        replace:
          "else this.state.set(topic, previous);\n" +
          indent +
          'if (topic === "cordis/tree") return; ' +
          dropMarker +
          "\n" +
          indent +
          'throw new Error("inspector: source state exceeds the source-frame byte limit");',
        expect: 1,
      },
    ],
    markers: [reserveMarker, dropMarker],
  };
}

export const STABILITY_PATCHES = [
  {
    id: 94,
    name: "BROWSER_COOKIE_NAME_IGNORE_PORT",
    layer: "代码",
    layer_en: "Code",
    desc: "桌面会话 cookie 名称计算忽略端口 / ignore port when hashing browser cookie name",
    surfaces: ["desktop"],
    file: "client-connection",
    rel: ["lib", "index.js"],
    replacements: [
      {
        pattern: 'encodeBase64Url(createHash("sha256").update(authority).digest())',
        replace:
          'encodeBase64Url(createHash("sha256").update(String(authority).replace(/:[0-9]+$/u, "")).digest()) /* [dsh-purge] cookie-name-ignore-port */',
      },
    ],
    marker: "[dsh-purge] cookie-name-ignore-port",
  },
  {
    id: 95,
    name: "HOST_MAX_HTTP_HEADER_SIZE",
    layer: "代码",
    layer_en: "Code",
    desc: "放宽桌面宿主 HTTP 请求头大小上限 / raise host max HTTP header size to 256KB",
    surfaces: ["desktop"],
    file: "desktop-shell",
    optional: true,
    replacements: [
      {
        pattern:
          /("--expose-internals",)(?: \/\* \[dsh-purge\] raise-host-header-limit \*\/ "--max-http-header-size=262144",)*/g,
        replace: '$1 /* [dsh-purge] raise-host-header-limit */ "--max-http-header-size=262144",',
      },
    ],
    marker: "[dsh-purge] raise-host-header-limit",
  },
  treeBudgetPatch(96, "experimental-inspector", "index.js", "spec.maxSourceFrameBytes"),
  treeBudgetPatch(97, "experimental-inspector-client", "client.js", "bootstrap.maxFrameBytes"),
  {
    id: 98,
    name: "ASK_USER_WAIT_CAPPED",
    layer: "工具",
    layer_en: "Tool",
    desc: "ask_user_question -1 无限等待收敛为 300 秒 / cap -1 wait at 300s",
    file: ["tool-ask-user"],
    rel: ["lib", "index.js"],
    optional: true,
    forbid: ["[dsh-purge] ask_user_question never blocks a turn"],
    replacements: [
      {
        pattern: "\t\t\tconst timeout = validateTimeout(args.timeout ?? defaultTimeout);",
        replace:
          "\t\t\tconst timeout = validateTimeout(args.timeout === -1 ? 300 : (args.timeout ?? defaultTimeout)); // [dsh-purge] -1 capped at 300s",
      },
      {
        pattern: "\t\t\tconst timeout = 1; // [dsh-purge] ask_user_question never blocks a turn",
        replace:
          "\t\t\tconst timeout = validateTimeout(args.timeout === -1 ? 300 : (args.timeout ?? defaultTimeout)); // [dsh-purge] -1 capped at 300s",
      },
    ],
    markers: ["[dsh-purge] -1 capped at 300s"],
  },
  {
    id: 99,
    name: "STEER_WAKE_LATCH",
    layer: "代码",
    layer_en: "Code",
    desc: "锁存运行期 wake 请求并在取消时清零 / latch running-phase wakes and clear on cancel",
    file: "agent-loop",
    rel: ["lib", "index.js"],
    optional: true,
    skipIfMarked: true,
    markersAny: true,
    replacements: [
      {
        pattern:
          '\t\t\tif (abortedCancelCause(this.phase.abort.signal)?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort)) this.phase.wakeRequested = true;',
        replace:
          '\t\t\tif (abortedCancelCause(this.phase.abort.signal)?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort || !this.phase.abort.signal.aborted)) this.phase.wakeRequested = true; // [dsh-purge-99] latch running-phase wakes so turn-tail messages are never stranded',
      },
      {
        pattern:
          '\tcancel(cause, options = {}) {\n\t\tif (!options.keepInbox) {\n\t\t\tthis.inbox.clear();\n\t\t\tif (this.phase.kind !== "idle") this.phase.wakeRequested = false;\n\t\t}\n\t\tif (this.phase.kind !== "idle") this.phase.abort.abort(cause);\n\t}',
        replace:
          '\tcancel(cause, options = {}) {\n\t\tif (!options.keepInbox) this.inbox.clear();\n\t\tif (this.phase.kind !== "idle") this.phase.wakeRequested = false; // [dsh-purge-99] stop means stop\n\t\tif (this.phase.kind !== "idle") this.phase.abort.abort(cause);\n\t}',
      },
    ],
    markers: ["[dsh-purge-99] latch running-phase wakes", "[dsh-purge-99] stop means stop"],
  },
];
