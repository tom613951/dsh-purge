import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  looksLikeDesktopName,
  isDesktopExecutable,
  isOfficialHarnessExecutable,
} from "../lib/desktop.js";
import { detectSurface, pathLooksDesktop, isCommunityElectronHost } from "../lib/surface.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "bin", "dsh-purge.js");

function runCliStatus(dshHome, desktopInstallDir) {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-iso-"));
  const env = { ...process.env };
  delete env.DSH_SURFACE;
  delete env.DSH_PROFILE;
  delete env.DSH_INSTALL;
  env.DSH_HOME = dshHome;
  env.DSH_BASE = path.join(iso, "missing-ai-base");
  env.HOME = iso;
  env.USERPROFILE = iso;
  env.LOCALAPPDATA = iso;
  env.APPDATA = iso;
  env.PROGRAMFILES = iso;
  env["ProgramFiles(x86)"] = iso;
  if (desktopInstallDir) env.DSH_DESKTOP_INSTALL = desktopInstallDir;
  else delete env.DSH_DESKTOP_INSTALL;
  try {
    return execFileSync(process.execPath, [CLI_PATH, "--status"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(iso, { recursive: true, force: true });
  }
}

test("DSH NEXT 路径和 exe 按桌面认", () => {
  assert.equal(looksLikeDesktopName("C:/Users/me/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe"), true);
  assert.equal(isDesktopExecutable("C:/Users/me/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe"), true);
  assert.equal(isOfficialHarnessExecutable("C:/Users/me/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe"), true);
  assert.equal(pathLooksDesktop("C:/Users/me/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe"), true);
});

test("DSH NEXT 即使 DSH_SURFACE=web 也判桌面", () => {
  const input = {
    env: { DSH_SURFACE: "web", DSH_PROFILE: "dsh-next" },
    execPath: "C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Programs\\\\DSH NEXT\\\\DSH NEXT.exe",
  };
  assert.equal(isCommunityElectronHost(input), true);
  assert.equal(detectSurface(input), "desktop");
});

test("普通路径不会因为带 app.asar 就当桌面", () => {
  assert.equal(pathLooksDesktop("/tmp/random-app/resources/app.asar"), false);
});

test("CLI --status 在仅存在 desktop profile 且探测到桌面端时自动启用 desktop", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cli-surface-"));
  try {
    const home = path.join(tmp, "home");
    const desktopDir = path.join(tmp, "install");
    fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
    fs.writeFileSync(path.join(home, "profiles", "desktop", "package.json"), "{}", "utf8");
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(path.join(desktopDir, "DSH NEXT.exe"), "", "utf8");
    fs.writeFileSync(path.join(desktopDir, "DSH NEXT"), "", "utf8");

    const desktopOut = runCliStatus(home, desktopDir);
    assert.match(desktopOut, /宿主 \/ surface desktop/);

    fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
    fs.writeFileSync(path.join(home, "profiles", "web", "package.json"), "{}", "utf8");
    const dualOut = runCliStatus(home, desktopDir);
    assert.match(dualOut, /宿主 \/ surface web/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
