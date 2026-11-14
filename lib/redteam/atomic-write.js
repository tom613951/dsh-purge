import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

let tmpSeq = 0

/**
 * 先建父目录，再写临时文件、fsync、关闭、再 rename。
 * 直接 writeFileSync 覆盖原文件时，写到一半崩溃会留下半截 JSON；读侧又会把解析错
 * 吞成默认值，用户的设置就无声消失了。
 */
export function atomicWriteFileSync(file, text, options = {}) {
  const opts = typeof options === 'string' ? { encoding: options } : (options || {})
  const mode = opts.mode
  if (opts.dirMode !== undefined) mkdirSync(dirname(file), { recursive: true, mode: opts.dirMode })
  else mkdirSync(dirname(file), { recursive: true })
  const seq = (tmpSeq += 1)
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${seq}.tmp`
  const fd = mode !== undefined ? openSync(tmp, 'w', mode) : openSync(tmp, 'w')
  try {
    const buf = Buffer.isBuffer(text) || ArrayBuffer.isView(text)
      ? Buffer.from(text.buffer, text.byteOffset, text.byteLength)
      : Buffer.from(String(text ?? ''), opts.encoding || 'utf8')
    let offset = 0
    while (offset < buf.byteLength) {
      offset += writeSync(fd, buf, offset, buf.byteLength - offset)
    }
    try { fsyncSync(fd) } catch { /* 部分文件系统不支持，忽略 */ }
  } catch (error) {
    try { closeSync(fd) } catch { /* ignore */ }
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  try {
    closeSync(fd)
  } catch { /* ignore */ }
  if (mode !== undefined) {
    try { chmodSync(tmp, mode) } catch { /* ignore */ }
  }
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}
