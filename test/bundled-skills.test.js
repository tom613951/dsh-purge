import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installBundledSkills } from "../lib/redteam/index.js";

test("installBundledSkills 识别并成功同步全部 27 个实战攻防随包技能", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-test-skills-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tempHome;

  try {
    const res = installBundledSkills();
    assert.ok(res.action === "installed" || res.action === "updated", `Unexpected action: ${res.action}`);
    assert.equal(res.copied, 27);
    assert.ok(fs.existsSync(res.path));
    const copied = fs.readdirSync(res.path).filter((f) => f.endsWith(".md"));
    assert.equal(copied.length, 27);
  } finally {
    process.env.DSH_HOME = prevHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("随包技能全量符合 UTF-8 编码且不含 BOM 或 Mojibake 乱码", () => {
  const skillsDir = path.resolve(import.meta.dirname, "../skills/redteam");
  assert.ok(fs.existsSync(skillsDir));
  const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 27);

  const mojibakePatterns = ["鐗堟湰", "绾㈤槦", "銆?", "\ufffd"];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(skillsDir, f));
    assert.ok(!raw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${f} contains UTF-8 BOM`);
    const text = raw.toString("utf8");
    for (const pat of mojibakePatterns) {
      assert.ok(!text.includes(pat), `${f} contains pattern ${pat}`);
    }
  }
});
