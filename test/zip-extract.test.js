import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { extractZipArchive, extractZipBuffer, unzipTools } from "../lib/zip-extract.js";

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data = "", dir = false, mode = 0, deflate = false, corruptCrc = false, uncompOverride } of entries) {
    const rawName = dir ? (name.endsWith("/") ? name : `${name}/`) : name;
    const rawBody = dir ? Buffer.alloc(0) : (Buffer.isBuffer(data) ? data : Buffer.from(data));
    const compressed = !dir && deflate ? zlib.deflateRawSync(rawBody) : rawBody;
    const method = !dir && deflate ? 8 : 0;
    const crc = ((zlib.crc32(rawBody) >>> 0) ^ (corruptCrc ? 0xdeadbeef : 0)) >>> 0;
    const nameBuf = Buffer.from(rawName, "utf8");
    const uncompSize = uncompOverride ?? rawBody.length;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const localOff = offset;
    localParts.push(local, compressed);
    offset += local.length + compressed.length;

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((mode >>> 0) << 16) >>> 0, 38);
    central.writeUInt32LE(localOff, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);
  }
  const centralBuf = Buffer.concat(centralParts);
  const localBuf = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

test("zip 目录条目建目录而不是空文件", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-zip-"));
  try {
    extractZipBuffer(buildZip([
      { name: "root/", dir: true },
      { name: "root/nested/", dir: true },
      { name: "root/nested/a.txt", data: "ok" },
    ]), dest);
    assert.equal(fs.statSync(path.join(dest, "root")).isDirectory(), true);
    assert.equal(fs.statSync(path.join(dest, "root", "nested")).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(dest, "root", "nested", "a.txt"), "utf8"), "ok");
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("unzipTools 只保留受限 node 读取器", () => {
  assert.deepEqual(unzipTools("win32"), ["node"]);
  assert.deepEqual(unzipTools("linux"), ["node"]);
  assert.deepEqual(unzipTools("darwin"), ["node"]);
});

test("zip 校验拒绝路径穿越、Windows 保留名、符号链接与重复路径", (t) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-zip-sec-"));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  for (const badName of ["../escape.txt", "/abs.txt", "C:drive.txt", "dir/CON.txt", "dir/trail.", "dir/space "]) {
    assert.throws(() => extractZipBuffer(buildZip([{ name: badName, data: "x" }]), dest), /路径不合法/);
  }
  assert.throws(
    () => extractZipBuffer(buildZip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]), dest),
    /链接条目/,
  );
  assert.throws(
    () => extractZipBuffer(buildZip([{ name: "dup.txt", data: "a" }, { name: "dup.txt", data: "b" }]), dest),
    /重复路径/,
  );
});

test("zip 校验强制检查 maxEntries、maxBytes、Zip64 与 CRC", (t) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-zip-limits-"));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  assert.throws(
    () => extractZipBuffer(buildZip([{ name: "a.txt", data: "1" }, { name: "b.txt", data: "2" }]), dest, { maxEntries: 1 }),
    /文件太多/,
  );
  const bomb = buildZip([{ name: "big.txt", data: "A".repeat(1024), deflate: true }]);
  assert.throws(() => extractZipBuffer(bomb, dest, { maxBytes: 128 }), /大小上限|buffer|length/i);

  const badCrc = buildZip([{ name: "bad.txt", data: "hello", corruptCrc: true }]);
  assert.throws(() => extractZipBuffer(badCrc, dest, { verifyCrc: true }), /CRC/);

  const zip64 = buildZip([{ name: "z64.txt", data: "x", uncompOverride: 0xffffffff }]);
  assert.throws(() => extractZipBuffer(zip64, dest), /zip64/i);

  const archivePath = path.join(dest, "ok.zip");
  const outDir = path.join(dest, "out");
  fs.writeFileSync(archivePath, buildZip([{ name: "skill/SKILL.md", data: "# ok", deflate: true }]));
  assert.equal(extractZipArchive(archivePath, outDir, { verifyCrc: true }), "node");
  assert.equal(fs.readFileSync(path.join(outDir, "skill", "SKILL.md"), "utf8"), "# ok");
});
