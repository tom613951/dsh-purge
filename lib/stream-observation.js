// 传输层流式诊断与观察通道：仅记录流式指标，不干预数据内容。
export async function* observeStream(factory, { report = () => {} } = {}) {
  let outcome = "cancelled";
  let chunks = 0;
  let chars = 0;
  let toolCall = false;
  let reasoning = false;
  let errorCode;

  try {
    for await (const chunk of factory()) {
      chunks += 1;
      if (chunk?.type === "text-delta") chars += String(chunk.text || "").length;
      if (chunk?.type === "tool-call-delta" || chunk?.type === "tool-call") toolCall = true;
      if (chunk?.type === "reasoning-delta") reasoning = true;
      yield chunk;
    }
    outcome = toolCall ? "tool_call" : chars ? "text" : reasoning ? "reasoning_only" : "empty";
  } catch (error) {
    outcome = "error";
    const code = typeof error?.code === "string" ? error.code : "";
    errorCode = /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "STREAM_ERROR";
    throw error;
  } finally {
    try {
      report({ outcome, chunks, chars, toolCall, reasoning, ...(errorCode ? { error: errorCode } : {}) });
    } catch {
      /* 诊断逻辑异常不中断主流 */
    }
  }
}
