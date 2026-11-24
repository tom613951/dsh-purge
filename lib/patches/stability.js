function treeBudgetPatch(id, file, moduleName) {
  const isClient = moduleName === "client.js";
  const dropMarker = "/* [dsh-purge] discard oversized Cordis tree */";
  return {
    id,
    name: isClient
      ? "INSPECTOR_FRAME_BUDGET_RECORD_OVERHEAD_CLIENT"
      : "INSPECTOR_FRAME_BUDGET_RECORD_OVERHEAD",
    layer: "代码",
    layer_en: "Code",
    desc: isClient
      ? "inspector 客户端丢弃超大 Cordis tree / drop oversized client cordis/tree"
      : "inspector 服务端丢弃超大 Cordis tree / drop oversized cordis/tree",
    file,
    rel: ["lib", moduleName],
    optional: true,
    silentWhenMissing: true,
    skipIfMarked: true,
    replacements: [
      isClient
        ? {
          pattern:
            'if(!this.stateFits()){if(previous===void 0)this.state.delete(topic);else this.state.set(topic,previous);throw new Error(`inspector: source state exceeds the source-frame byte limit`)}this.enqueue(record)',
          replace:
            'if(!this.stateFits()){if(previous===void 0)this.state.delete(topic);else this.state.set(topic,previous);if(topic===`cordis/tree`)return; ' +
            dropMarker +
            'throw new Error(`inspector: source state exceeds the source-frame byte limit`)}this.enqueue(record)',
        }
        : {
          pattern:
            "else this.state.set(topic, previous);\n\t\t\tthrow new Error(\"inspector: source state exceeds the source-frame byte limit\");",
          replace:
            "else this.state.set(topic, previous);\n\t\t\tif (topic === \"cordis/tree\") return; " +
            dropMarker +
            "\n\t\t\tthrow new Error(\"inspector: source state exceeds the source-frame byte limit\");",
        },
    ],
    markers: [dropMarker],
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
  treeBudgetPatch(96, "experimental-inspector", "index.js"),
  treeBudgetPatch(97, "experimental-inspector-client", "client.js"),
  {
    id: 98,
    name: "ASK_USER_WAIT_CAPPED",
    layer: "工具",
    layer_en: "Tool",
    desc: "ask_user_question -1 无限等待收敛为 300 秒 / cap -1 wait at 300s",
    file: ["tool-ask-user"],
    rel: ["lib", "index.js"],
    optional: true,
    replacements: [
      {
        pattern: "\t\t\tconst timeout = validateTimeout(args.timeout ?? defaultTimeout);",
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
    desc: "锁存运行期 wake 请求 / latch running-phase wakes",
    file: "agent-loop",
    rel: ["lib", "index.js"],
    optional: true,
    skipIfMarked: true,
    replacements: [
      {
        pattern:
          '\t\t\tif (abortedCancelCause(this.phase.abort.signal)?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort)) this.phase.wakeRequested = true;',
        replace:
          '\t\t\tif (abortedCancelCause(this.phase.abort.signal)?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort || !this.phase.abort.signal.aborted)) this.phase.wakeRequested = true; // [dsh-purge-99] latch running-phase wakes so turn-tail messages are never stranded',
      },
    ],
    markers: ["[dsh-purge-99] latch running-phase wakes"],
  },
];
