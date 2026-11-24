import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { asarArchiveIsFile, diskFs, hostFs } from "./extract-asar.js";
import { atomicWriteSync } from "./core.js";

function restartUniqSuffix() {
  return `${process.pid}-${randomBytes(4).toString("hex")}`;
}

// 无归档时用 node:fs。app.asar 还在时不能把映射出来的 resources/app 当成已经解开。
const fs = hostFs;

// [dsh-purge-fix 2026-10-09] console.warn 写 host stderr → main.js:3729 host.exitPromise
// fail 回调把最后一行 stderr 当 Error reason。helper restart 期间任何 warn 都可能
// 被误判成 crash log。改走内部文件,不污染 stderr。
const INTERNAL_LOG_PATH = path.join(os.tmpdir(), "dsh-purge-desktop.log");
function logInternal(msg) {
  try {
    const line = `${new Date().toISOString()} [dsh-purge] ${String(msg)}\n`;
    fs.appendFileSync(INTERNAL_LOG_PATH, line, "utf8");
  } catch {
    /* 日志写不进去就吞,绝不走 stderr */
  }
}

/** 路径落在 `app.asar/...` 里面。`app.asar` 文件本身和 `app.asar.unpacked` 不算。 */
export function isAsarSealedPath(p) {
  const parts = String(p || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return false;
  return parts.slice(0, -1).some((seg) => {
    const s = seg.toLowerCase();
    return s.endsWith(".asar") && !s.endsWith(".asar.unpacked");
  });
}

function isFile(fp) {
  try {
    if (isAsarSealedPath(fp)) return false;
    return Boolean(fp) && fs.existsSync(fp) && fs.statSync(fp).isFile();
  } catch {
    return false;
  }
}

function isDir(fp) {
  try {
    if (isAsarSealedPath(fp)) return false;
    return Boolean(fp) && fs.existsSync(fp) && fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

function isAiBase(p) {
  return Boolean(p) && isDir(path.join(p, "dsh-agent-instructions", "lib"));
}

function uniquePaths(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const n = path.normalize(item);
    const key = n.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function slashNorm(p) {
  return path.normalize(String(p || "")).replace(/\\/g, "/").toLowerCase();
}

function isSubPath(child, root) {
  const c = slashNorm(child).replace(/\/+$/, "");
  const r = slashNorm(root).replace(/\/+$/, "");
  if (!c || !r || r === "/") return false;
  if (/^[a-z]:$/.test(r)) return false;
  return c === r || c.startsWith(`${r}/`);
}

/**
 * 社区桌面、官方 exe、.app 包才算安装树。
 * 只是上级文件夹叫 DeepSeek Harness 不算：npm 前缀和配置目录经常用这个名字，
 * 按名字整棵排除的话，Web 的身份句和 complete 注入补丁会被跳过。
 */
export function looksLikeDesktopName(p) {
  const n = slashNorm(p);
  if (!n) return false;
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.endsWith("/dsh desktop") ||
    n.endsWith("/dsh desktop.app") ||
    n.includes("dsh-desktop") ||
    n.includes("/dsh next/") ||
    n.includes("/dsh next.app/") ||
    n.endsWith("/dsh next") ||
    n.endsWith("/dsh next.app") ||
    n.includes("dsh-next") ||
    n.includes("dsh-desktop-next") ||
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness(\/|$)/.test(n) ||
    n.includes("/deepseek harness.app/") ||
    n.endsWith("/deepseek harness.app") ||
    n.includes("/deepseek bot/") ||
    n.includes("/deepseek-bot/") ||
    n.includes("/ds-bot/") ||
    n.endsWith("/deepseek bot") ||
    n.endsWith("/deepseek bot.app") ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/dsh next\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*bot\.exe$/i.test(n)
  );
}

const OFFICIAL_HARNESS_BASES = new Set([
  "deepseek harness.exe",
  "deepseek-harness.exe",
  "deepseek harness",
  "deepseek-harness",
  "dsh next.exe",
  "dsh next",
  "dsh-next.exe",
  "dsh-next",
]);

/**
 * 只把「路径自己那一段」当桌面名字，不看祖先目录。
 *
 * 上面那段注释说要避免的事，原实现其实在做：`n.includes("/deepseek harness/")`
 * 会命中任意祖先目录。而 npm 前缀（`D:\DeepSeek Harness\npm-global\…`）和
 * DSH_HOME 的父目录（`D:\DeepSeek Harness\.dsh` 的上级）恰好都叫这个名字 ——
 * 于是 Web 安装根被判成桌面，findAiBaseWeb 里每一处
 * `!isInsideDesktopInstall(cand)` 守卫都会把正确答案踢掉，Web 面定位不到宿主。
 *
 * 真正的桌面安装靠结构标记判定：路径里含 `/resources/app/`、
 * `/resources/app.asar.unpacked/` 或 `/contents/resources/`（见 inferDesktopInstallDir）。
 * 名字只作为「这一级目录本身就是安装根」的兜底。
 */
export function looksLikeDesktopNameTail(p) {
  const n = slashNorm(p).toLowerCase().replace(/\/+$/, "");
  if (!n) return false;
  const cut = n.lastIndexOf("/");
  const tail = cut >= 0 ? n.slice(cut + 1) : n;
  if (!tail) return false;
  return (
    tail === "dsh desktop" ||
    tail === "dsh desktop.app" ||
    tail === "dsh next" ||
    tail === "dsh next.app" ||
    tail === "deepseek harness" ||
    tail === "deepseek harness.app" ||
    tail === "deepseek-harness" ||
    tail === "deepseekharness" ||
    /^dsh-desktop/.test(tail) ||
    /^dsh-next/.test(tail) ||
    /^dsh[\s._-]*next(\.exe)?$/.test(tail) ||
    /^deepseek[\s._-]*harness(\.exe)?$/.test(tail) ||
    tail === "deepseek bot" ||
    tail === "deepseek bot.app" ||
    tail === "deepseek-bot" ||
    tail === "ds-bot" ||
    /^deepseek[\s._-]*bot(\.exe)?$/.test(tail)
  );
}

function sameBase(name, expected) {
  return String(name || "").toLowerCase() === expected;
}

export function isDesktopExecutable(fp) {
  const base = path.basename(String(fp || "")).toLowerCase();
  if (base === "dsh desktop.exe" || base === "dsh desktop") return true;
  if (base === "dsh next.exe" || base === "dsh next") return true;
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  if (/^deepseek[\s._-]*bot(\.exe)?$/.test(base) || /^ds[\s._-]*bot(\.exe)?$/.test(base)) return true;
  if (/^dsh[\s._-]*next(\.exe)?$/.test(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

/** 官方 DeepSeek Harness 和带 asar 的 DSH NEXT 会解开 app.asar。第三方 DSH Desktop 不走这条。 */
export function isOfficialHarnessExecutable(fp) {
  const base = path.basename(String(fp || "")).toLowerCase();
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  if (/^dsh[\s._-]*next(\.exe)?$/.test(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

export function resourceDirCandidates(installDir) {
  if (!installDir) return [];
  const name = path.basename(installDir);
  if (sameBase(name, "resources")) return [installDir];
  return [path.join(installDir, "resources"), path.join(installDir, "Resources")];
}

/** 官方宿主的 resources 目录。已存在的 app.asar 优先，否则用该平台的常规目录名。 */
export function resourcesDirForExecutable(exe) {
  const exeDir = path.dirname(path.normalize(String(exe || "")));
  if (!exeDir) return "";
  const cands = resourceDirCandidates(exeDir);
  const withAsar = cands.find((dir) => isFile(path.join(dir, "app.asar")));
  if (withAsar) return withAsar;
  const existing = cands.find((dir) => isDir(dir));
  if (existing) return existing;
  return cands[0] || "";
}

export function appAsarPath(exe) {
  const dir = resourcesDirForExecutable(exe);
  return dir ? path.join(dir, "app.asar") : "";
}

export function appDirForExecutable(exe) {
  const dir = resourcesDirForExecutable(exe);
  return dir ? path.join(dir, "app") : "";
}

/* ---------------------------------------------------------------- office-skills 自愈
 * resources/runtime/office-skills/office/SKILL.md 缺失时，dsh-skill-office 初始化
 * 同步读七个文件，桌面端直接 DesktopHostFatalError 退出。这里在“应用能起来”的
 * 前提下把缺的文件从 app.asar / npm 安装树补回磁盘，避免下次再崩。
 * 注意：救不了崩溃当次（崩溃发生在 Fiber._reload，比插件早）。
 */
const OFFICE_SKILL_MARKER = ["office", "SKILL.md"];
const OFFICE_COPY_MAX_DEPTH = 12;

function copySkillTree(src, dest, reader, writer, depth = 0) {
  if (depth > OFFICE_COPY_MAX_DEPTH) return;
  try { writer.mkdirSync(dest, { recursive: true }); } catch { return; }
  let entries;
  try { entries = reader.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry || !entry.name) continue;
    // 只跟真目录；符号链接可能指回上层，递归会绕圈。
    if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copySkillTree(from, to, reader, writer, depth + 1);
    } else if (entry.isFile()) {
      try {
        if (writer.existsSync(to)) continue;
        writer.mkdirSync(path.dirname(to), { recursive: true });
        writer.writeFileSync(to, reader.readFileSync(from));
      } catch { /* 单个文件失败不挡整棵树 */ }
    }
  }
}

export function healOfficeSkillsAt(resourcesDir, appDir = "", extraSources = []) {
  if (!resourcesDir) return { ok: false, reason: "no-resources" };
  const dest = path.join(resourcesDir, "runtime", "office-skills");
  const marker = path.join(dest, ...OFFICE_SKILL_MARKER);
  const out = diskFs();
  try { if (out.existsSync(marker)) return { ok: true, healed: false, dest }; } catch { /* 下面按缺失处理 */ }
  const sources = [
    appDir ? path.join(appDir, "runtime", "office-skills") : "",
    appDir ? path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets") : "",
    path.join(resourcesDir, "app", "runtime", "office-skills"),
    path.join(resourcesDir, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    // 打包安装的资源在 asar 里，hostFs 认 asar 路径。
    path.join(resourcesDir, "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    path.join(resourcesDir, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    ...(Array.isArray(extraSources) ? extraSources : []),
  ].filter(Boolean);
  const src = sources.find((dir) => {
    try { return hostFs.existsSync(path.join(dir, ...OFFICE_SKILL_MARKER)); } catch { return false; }
  });
  if (!src) return { ok: false, reason: "no-source", dest };
  try {
    copySkillTree(src, dest, hostFs, out);
    return { ok: out.existsSync(marker), healed: true, src, dest };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error), src, dest };
  }
}

export function healOfficeSkillsRuntimeOnDisk(extraSources = []) {
  const exe = findDesktopAppExecutable();
  if (!exe || !isOfficialHarnessExecutable(exe)) return { ok: false, reason: "no-exe" };
  return healOfficeSkillsAt(resourcesDirForExecutable(exe), appDirForExecutable(exe), extraSources);
}

function exeCandidatesBeside(dir) {
  if (!dir) return [];
  return [
    path.join(dir, "DSH NEXT.exe"),
    path.join(dir, "DeepSeek Harness.exe"),
    path.join(dir, "deepseek-harness.exe"),
    path.join(dir, "DSH Desktop.exe"),
    path.join(dir, "DeepSeek Bot.exe"),
    path.join(dir, "DeepSeek-Bot.exe"),
  ];
}

function firstExistingExe(dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const cand of exeCandidatesBeside(dir)) {
      if (isFile(cand)) return path.normalize(cand);
    }
  }
  return "";
}

const APP_SCRIPT_RE = /(desktop-cli|host-process-entry)\.js$/i;

function installDirsFromAppScript(scriptPath) {
  if (!scriptPath) return [];
  const abs = path.resolve(scriptPath);
  const lib = path.dirname(abs);
  const app = path.dirname(lib);
  const resources = path.dirname(app);
  const install = path.dirname(resources);
  return uniquePaths([lib, app, resources, install]);
}

/** 从任意 `.../resources/app/...` 树反推安装目录（不要求文件夹叫 DSH Desktop）。 */
export function inferDesktopInstallDir(p) {
  const raw = path.normalize(String(p || "")).replace(/\\/g, "/");
  const n = raw.toLowerCase();
  if (!n) return "";
  const markers = [
    "/resources/app.asar.unpacked/",
    "/resources/app/",
    "/contents/resources/",
  ];
  for (const marker of markers) {
    const i = n.indexOf(marker);
    if (i <= 0) continue;
    return path.normalize(raw.slice(0, i));
  }
  return "";
}

function extraInstallsFromEnv(env = process.env) {
  return String(env.DSH_DESKTOP_INSTALL || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trustedInstallDir(dir) {
  if (!dir) return false;
  if (looksLikeDesktopName(dir)) return true;
  if (firstExistingExe([dir])) return true;
  return (
    isAiBase(path.join(dir, "resources", "app", "dsh", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app.asar.unpacked", "node_modules", "@deepseek-ai"))
  );
}

const REGISTRY_INSTALL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$names = @('DeepSeek Harness','DSH Desktop','DSH NEXT','DeepSeek Bot','DS Bot')
$roots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
$rows = foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName) { return }
    $hit = $false
    foreach ($n in $names) { if ($p.DisplayName -like ('*' + $n + '*')) { $hit = $true } }
    if (-not $hit) { return }
    [pscustomobject]@{
      InstallLocation = [string]$p.InstallLocation
      DisplayIcon = [string]$p.DisplayIcon
      UninstallString = [string]$p.UninstallString
    }
  }
}
if ($rows) { @($rows) | ConvertTo-Json -Compress }
`.trim();

function exeDirFromRegistryValue(value) {
  let val = String(value || "").trim();
  const quoted = val.match(/^"([^"]+)"/);
  if (quoted) val = quoted[1];
  val = val.replace(/,0$/, "").trim();
  if (!val) return "";
  return path.normalize(path.dirname(val));
}

let cachedRegistryDirs;
/** 从卸载登记读安装目录。盘符跟着用户安装位置，不写死。 */
export function registryInstallDirs() {
  if (cachedRegistryDirs !== undefined) return cachedRegistryDirs;
  if (process.platform !== "win32") {
    cachedRegistryDirs = [];
    return cachedRegistryDirs;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", REGISTRY_INSTALL_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 << 20,
    });
  } catch {
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  const found = [];
  for (const row of rows) {
    const location = String(row.InstallLocation || "").trim();
    if (location) found.push(path.normalize(location));
    found.push(exeDirFromRegistryValue(row.DisplayIcon));
    found.push(exeDirFromRegistryValue(row.UninstallString));
  }
  const result = uniquePaths(found).filter((dir) => firstExistingExe([dir]));
  if (result.length > 0) cachedRegistryDirs = result;
  return result;
}

const PORTABLE_INSTALL_NAMES = [
  "DeepSeek Harness",
  "DeepseekHarnessDesktop",
  "DeepSeekHarnessDesktop",
  "DSH Desktop",
  "DSH NEXT",
  "deepseek-harness",
];

function homeSiblingInstalls(env = process.env) {
  const homes = [env.DSH_HOME, env.DSH_BASE].filter(Boolean);
  const dirs = [];
  for (const raw of homes) {
    const start = path.normalize(String(raw));
    dirs.push(start, path.dirname(start), path.dirname(path.dirname(start)));
  }
  return uniquePaths(dirs).filter((dir) => firstExistingExe([dir]));
}

/** 用户目录和各盘根下一层常见文件夹名。不扫整盘。 */
function portableInstallGuesses(env = process.env) {
  const home = os.homedir();
  const cands = [];
  for (const folder of ["Desktop", "Documents", "Downloads"]) {
    for (const name of PORTABLE_INSTALL_NAMES) {
      cands.push(path.join(home, folder, name));
    }
  }
  for (const name of PORTABLE_INSTALL_NAMES) {
    cands.push(path.join(home, name));
  }
  if (process.platform === "win32") {
    for (const letter of "CDEFGHI") {
      for (const name of PORTABLE_INSTALL_NAMES) {
        cands.push(`${letter}:\\${name}`);
      }
    }
  }
  return uniquePaths(cands).filter((dir) => firstExistingExe([dir]));
}

function walkParentsForOfficialExe(start, maxUp = 8) {
  if (!start) return "";
  let dir = "";
  try {
    const abs = path.resolve(String(start));
    dir = isDir(abs) ? abs : path.dirname(abs);
  } catch {
    return "";
  }
  for (let i = 0; i < maxUp && dir; i += 1) {
    const hit = firstExistingExe([dir]);
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

const PROCESS_EXE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$re = 'DeepSeek Harness\\.exe$|deepseek-harness\\.exe$|DSH Desktop\\.exe$|DSH NEXT\\.exe$'
$paths = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -match $re } |
  Select-Object -ExpandProperty ExecutablePath)
if ($paths) { @($paths) | ConvertTo-Json -Compress }
`.trim();

let cachedRunningExes;
function runningOfficialExecutables() {
  if (cachedRunningExes !== undefined) return cachedRunningExes;
  if (process.platform !== "win32") {
    cachedRunningExes = [];
    return cachedRunningExes;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", PROCESS_EXE_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      // 15s 会把启动期的 UI 线程卡 15s;Win32_Process 枚举 1-3s 够用,超时直接退不缓存。
      timeout: 6000,
      maxBuffer: 8 << 20,
    });
  } catch {
    // 探测失败不缓存空结果，否则整次进程都找不到正在跑的客户端。
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  // 结果为空也不缓存：客户端可能稍后才启动，否则本进程后续永远找不到它。
  const result = uniquePaths(rows.map((item) => String(item || "").trim()).filter((fp) => isDesktopExecutable(fp) && isFile(fp)));
  if (result.length > 0) cachedRunningExes = result;
  return result;
}

const SHORTCUT_EXE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$shell = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ }
$pats = @('*DeepSeek*Harness*.lnk','*DSH Desktop*.lnk','*DSH NEXT*.lnk','*deepseek-harness*.lnk','*dsh-next*.lnk')
$out = New-Object System.Collections.Generic.List[string]
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($pat in $pats) {
    Get-ChildItem -LiteralPath $root -Filter $pat -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 16 | ForEach-Object {
        try {
          $t = $shell.CreateShortcut($_.FullName).TargetPath
          if ($t) { $out.Add([string]$t) }
        } catch {}
      }
  }
}
if ($out.Count) { @($out) | ConvertTo-Json -Compress }
`.trim();

let cachedShortcutExes;
function shortcutOfficialExecutables() {
  if (cachedShortcutExes !== undefined) return cachedShortcutExes;
  if (process.platform !== "win32") {
    cachedShortcutExes = [];
    return cachedShortcutExes;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", SHORTCUT_EXE_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 << 20,
    });
  } catch {
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  const result = uniquePaths(rows.map((item) => String(item || "").trim()).filter((fp) => isDesktopExecutable(fp) && isFile(fp)));
  if (result.length > 0) cachedShortcutExes = result;
  return result;
}

/** 点「应用」前清掉失败的空缓存，重新找本机 exe。 */
export function clearDesktopLocateCache() {
  cachedRunningExes = undefined;
  cachedShortcutExes = undefined;
  cachedRegistryDirs = undefined;
}

function extraDiscoveredInstallDirs(env = process.env, input = {}) {
  const cheap = [
    ...homeSiblingInstalls(env),
    ...portableInstallGuesses(env),
  ];
  if (input.discover !== true) return uniquePaths(cheap);
  return uniquePaths([
    ...cheap,
    ...runningOfficialExecutables().map((exe) => path.dirname(exe)),
    ...shortcutOfficialExecutables().map((exe) => path.dirname(exe)),
  ]);
}

/** NSIS / 商店默认位置；不是全盘扫描。discover 才查注册表 / 进程 / 快捷方式。 */
export function commonDesktopInstallDirs(env = process.env, input = {}) {
  const discover = input.discover === true;
  const home = os.homedir();
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = env.ProgramFiles || "";
  const pf86 = env["ProgramFiles(x86)"] || "";
  return uniquePaths([
    ...extraInstallsFromEnv(env).filter(trustedInstallDir),
    ...(discover ? registryInstallDirs() : []),
    ...extraDiscoveredInstallDirs(env, { discover }),
    path.join(local, "Programs", "DeepSeek Harness"),
    path.join(local, "Programs", "DSH Desktop"),
    path.join(local, "Programs", "DSH NEXT"),
    path.join(local, "Programs", "DeepSeek Bot"),
    path.join(local, "DeepSeek Harness"),
    path.join(local, "DSH NEXT"),
    path.join(local, "DeepSeek Bot"),
    ...(pf
      ? [path.join(pf, "DeepSeek Harness"), path.join(pf, "DSH Desktop"), path.join(pf, "DSH NEXT"), path.join(pf, "DeepSeek Bot")]
      : []),
    ...(pf86
      ? [path.join(pf86, "DeepSeek Harness"), path.join(pf86, "DSH Desktop"), path.join(pf86, "DSH NEXT"), path.join(pf86, "DeepSeek Bot")]
      : []),
  ]);
}

export function listDesktopInstallRoots(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const roots = [];

  if (isDesktopExecutable(execPath)) {
    roots.push(path.dirname(path.normalize(execPath)));
  }

  if (resourcesPath) {
    const res = path.normalize(resourcesPath);
    roots.push(res, path.dirname(res), path.join(res, "app"), path.join(res, "app.asar.unpacked"));
  }

  for (const arg of argv) {
    if (typeof arg === "string" && APP_SCRIPT_RE.test(arg)) {
      roots.push(...installDirsFromAppScript(arg));
    }
  }

  for (const extra of extraInstallsFromEnv(env)) {
    if (trustedInstallDir(extra)) roots.push(extra);
  }
  return uniquePaths(roots);
}

/**
 * 是否落在社区 Desktop 安装树。
 * 不依赖盘符、也不要求文件夹叫 “DSH Desktop”：
 * 当前进程的 exe / resources / host-process-entry、旁边真有桌面 exe，或社区安装目录名。
 */
export function isInsideDesktopInstall(p, input = {}) {
  if (!p) return false;
  // 名字兜底只看路径尾部那一段，不看祖先目录名 —— 见 looksLikeDesktopNameTail。
  if (looksLikeDesktopNameTail(p)) return true;
  const roots = listDesktopInstallRoots(input);
  if (roots.some((root) => isSubPath(p, root))) return true;
  const inferred = inferDesktopInstallDir(p);
  if (!inferred) return false;
  if (roots.some((root) => isSubPath(inferred, root) || isSubPath(root, inferred))) return true;
  return Boolean(firstExistingExe([inferred]));
}

export function findDesktopAppExecutable(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const discover = input.discover === true;

  if (isDesktopExecutable(execPath) && isFile(execPath)) return path.normalize(execPath);

  const electron = (input.versions ?? process.versions)?.electron;
  if (
    electron
    && isFile(execPath)
    && !/^node(\.exe)?$/i.test(path.basename(execPath))
  ) {
    return path.normalize(execPath);
  }

  if (resourcesPath) {
    const hit = firstExistingExe([path.dirname(path.normalize(resourcesPath))]);
    if (hit) return hit;
  }

  for (const arg of argv) {
    if (typeof arg !== "string" || !APP_SCRIPT_RE.test(arg)) continue;
    const hit = firstExistingExe(installDirsFromAppScript(arg));
    if (hit) return hit;
  }

  const walkStarts = [execPath, resourcesPath, env.DSH_HOME, env.DSH_BASE];
  try { walkStarts.push(process.cwd()); } catch { /* ignore */ }
  for (const arg of argv) {
    if (typeof arg === "string") walkStarts.push(arg);
  }
  for (const start of walkStarts) {
    const hit = walkParentsForOfficialExe(start);
    if (hit) return hit;
  }

  if (discover) {
    const running = runningOfficialExecutables();
    if (running[0]) return running[0];
    const shortcuts = shortcutOfficialExecutables();
    if (shortcuts[0]) return shortcuts[0];
  }

  const guessed = firstExistingExe([
    ...extraInstallsFromEnv(env),
    ...commonDesktopInstallDirs(env, { discover }),
  ]);
  return guessed || "";
}

function packageRootsFromInstall(installDir) {
  if (!installDir) return [];
  const out = [];
  for (const resources of resourceDirCandidates(installDir)) {
    out.push(
      path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resources, "app", "node_modules", "@deepseek-ai"),
      path.join(resources, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resources, "app.asar.unpacked", "node_modules", "@deepseek-ai"),
    );
  }
  return out;
}

export function listDesktopPackageRoots(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const discover = input.discover === true;
  const cands = [];

  if (resourcesPath) {
    cands.push(
      path.join(resourcesPath, "app", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@deepseek-ai"),
    );
  }

  if (isDesktopExecutable(execPath)) {
    cands.push(...packageRootsFromInstall(path.dirname(execPath)));
  }

  const exe = findDesktopAppExecutable(input);
  if (exe) cands.push(...packageRootsFromInstall(path.dirname(exe)));

  for (const arg of argv) {
    if (typeof arg !== "string" || !APP_SCRIPT_RE.test(arg)) continue;
    const appDir = path.dirname(path.dirname(path.resolve(arg)));
    cands.push(path.join(appDir, "node_modules", "@deepseek-ai"));
    cands.push(path.join(appDir, "dsh", "node_modules", "@deepseek-ai"));
    cands.push(...packageRootsFromInstall(path.dirname(path.dirname(appDir))));
  }

  const localHits = uniquePaths(cands).filter(isAiBase);
  // 已经在某个桌面 exe 里时，只改这一份。旁边装了另一种客户端也不能被带上。
  if (isDesktopExecutable(execPath)) return localHits;
  // 启动自愈：exe / 环境 / 常见目录已经够用。注册表和快捷方式留给点「应用」。
  if (!discover && localHits.length) return localHits;

  for (const install of commonDesktopInstallDirs(env, { discover })) {
    cands.push(...packageRootsFromInstall(install));
  }

  return uniquePaths(cands).filter(isAiBase);
}

export function resolveDesktopAiBase(input = {}) {
  return listDesktopPackageRoots(input)[0] || null;
}

export function isSealedRuntimeDir(dir) {
  if (!dir) return false;
  const n = path.normalize(dir).replace(/\\/g, "/").toLowerCase();
  if (!/(^|\/)bin\/?$/.test(n)) return false;
  return (
    n.includes("/host-commands/") ||
    n.includes("/runtime-commands/") ||
    n.includes("/dsh desktop/")
  );
}

export function sealedRuntimeRoots(env = process.env) {
  const home = os.homedir();
  const appdata = env.APPDATA || path.join(home, "AppData", "Roaming");
  const localapp = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return uniquePaths([
    path.join(appdata, "DSH Desktop", "host-commands"),
    path.join(appdata, "DSH Desktop", "runtime-commands"),
    path.join(localapp, "DSH Desktop", "host-commands"),
    path.join(localapp, "DSH Desktop", "runtime-commands"),
  ]);
}

function walkBinDirs(dir, out, depth) {
  if (depth < 0 || !isDir(dir)) return;
  const n = dir.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)bin$/.test(n)) {
    out.push(path.normalize(dir));
    return;
  }
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (ent.isDirectory()) walkBinDirs(path.join(dir, ent.name), out, depth - 1);
  }
}

export function listSealedRuntimeBins(env = process.env) {
  const out = [];
  for (const root of sealedRuntimeRoots(env)) walkBinDirs(root, out, 5);
  return uniquePaths(out).filter(isSealedRuntimeDir);
}

export function restartNote() {
  return "正在重启桌面应用…";
}

export function restartPlan(input = {}) {
  const exe = findDesktopAppExecutable(input);
  if (!exe) {
    return { kind: "desktop", execPath: "", argv: [], cwd: "", error: "未找到 DSH Desktop.exe，无法重启桌面应用" };
  }
  return {
    kind: "desktop",
    execPath: exe,
    argv: [],
    cwd: path.dirname(exe),
  };
}

function helperEnv(payload, runner) {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  if (runner && path.basename(runner).toLowerCase().includes("node")) {
    delete env.ELECTRON_RUN_AS_NODE;
  } else {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  env.DSH_PURGE_RESTART = JSON.stringify(payload);
  return env;
}

// #85 reverted: host 自己同步杀 Electron 会导致 host 作为 Electron 子进程被 Job
// Object 连带杀,spawnHelper 来不及调用 → relaunch 彻底失败 (YG 实测现象:点"重启"
// 没反应,DSH 全死没 relaunch)。改回让 helper 全权处理 kill+relaunch,crash dialog
// 问题靠 patch #83+#84 (新 main.js 加载后 close 回调 silent) 解决第二次之后,
// 第一次 restart 的 crash dialog 是 Electron 内存版本滞后的必然代价,无法避免。

/** 换包助手不能再用 Electron 本体跑：Stop-HarnessInstall / taskkill 按 exe 名会先把自己杀掉，app.asar 永远挪不开（#133）。 */
function helperNodePath() {
  if (!process.versions.electron) return process.execPath;
  const hinted = String(process.env.DSH_NODE || "").trim();
  if (hinted && isFile(hinted)) return hinted;
  try {
    const out = execFileSync("where.exe", ["node"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    const first = String(out || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && isFile(first)) return first;
  } catch {
    /* 没有系统 node 时再退回 Electron + RUN_AS_NODE */
  }
  return process.execPath;
}

function spawnHelper(helper, payload, opts = {}) {
  const plan = restartPlan();
  const hinted = payload && payload.execPath ? payload.execPath : "";
  const execPath = hinted || plan.execPath;
  if (!execPath) throw new Error(plan.error || "未找到 DSH Desktop.exe，无法重启桌面应用");
  const runner = helperNodePath();
  const child = spawn(runner, [helper], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    env: helperEnv({
      kind: "desktop",
      execPath,
      argv: plan.argv,
      cwd: plan.cwd || path.dirname(execPath),
      pid: process.pid,
      helperPidKeep: true,
      ...payload,
    }, runner),
  });
  child.unref();
  if (opts.exit !== false) setTimeout(() => process.exit(0), opts.exitAfter ?? 250);
}

function desktopRuntimeOf(ctx) {
  if (!ctx || typeof ctx.get !== "function") return null;
  const runtime = ctx.get("desktopRuntime") || ctx.get("desktopActions");
  return runtime && typeof runtime.requestRestart === "function" ? runtime : null;
}

export const ASAR_SWAP_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][int]$WaitPid,",
  "  [Parameter(Mandatory = $true)][string]$AsarPath,",
  "  [Parameter(Mandatory = $true)][string]$ExePath",
  ")",
  "$ErrorActionPreference = 'Continue'",
  "$log = Join-Path $env:TEMP 'dsh-purge-desktop.log'",
  "function Write-SwapLog([string]$message) {",
  "  try { Add-Content -LiteralPath $log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' [asar-swap] ' + $message) -ErrorAction SilentlyContinue } catch {}",
  "}",
  "$installRoot = (Split-Path -Parent $ExePath).TrimEnd('\\')",
  "$exeNorm = $ExePath.ToLower()",
  "function Stop-HarnessInstall {",
  "  # 仅按本次安装根路径杀本安装的进程；不再用 /IM 全名杀，避免误伤同名第三方。",
  "  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "    $ep = $_.ExecutablePath",
  "    if (-not $ep) { return $false }",
  "    $low = $ep.ToLower()",
  "    return ($low -eq $exeNorm) -or $low.StartsWith($installRoot.ToLower() + '\\')",
  "  } | ForEach-Object {",
  "    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
  "  }",
  "}",
  "# #64 crash-dialog 根因消除:不再等 WaitPid (host) 优雅退出,因为那样 Electron main",
  "# 会先看到 host 退出 -> main.js:3725 ChildProcess listener 弹\"host stopped\"对话框。",
  "# 改为立即 Stop-HarnessInstall (包括 Electron main + host 一起杀),Electron 还没",
  "# 来得及处理 host 退出事件就被 kill,UI 根本不存在,无法弹 crash dialog。",
  "# PowerShell 本身是 detached 独立进程(spawn 时 detached:true, stdio:ignore),",
  "# 杀 Electron 不会连带杀 PowerShell。",
  "# #197b: 先杀 Electron main。main 是唯一会弹「host stopped」对话框的进程：",
  "# 若先杀 host，main 还活着就会弹框，然后脚本若在挪 asar 前失败，用户就卡在",
  "# 「host 死了、main 半死、asar 没动」的状态（2026-10-31 实测）。先杀 main 就没框。",
  "$mains = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "  $ep = $_.ExecutablePath",
  "  if (-not $ep) { return $false }",
  "  ($ep.ToLower() -eq $exeNorm) -and ($_.CommandLine -notmatch '--type=')",
  "})",
  "foreach ($p in $mains) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
  "Start-Sleep -Milliseconds 400",
  "Stop-HarnessInstall",
  "Start-Sleep -Milliseconds 500",
  "Stop-HarnessInstall",
  "Start-Sleep -Milliseconds 300",
  "# 兜底:万一上面没完全杀干净(例如 CimInstance 枚举漏掉某个进程),再按短超时等一下。",
  "$deadline = (Get-Date).AddSeconds(10)",
  "while ((Get-Date) -lt $deadline) {",
  "  $self = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue",
  "  $holding = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "    $ep = $_.ExecutablePath",
  "    if (-not $ep) { return $false }",
  "    $low = $ep.ToLower()",
  "    ($low -eq $exeNorm) -or $low.StartsWith($installRoot.ToLower() + '\\')",
  "  })",
  "  if (-not $self -and $holding.Count -eq 0) { break }",
  "  Stop-HarnessInstall",
  "  Start-Sleep -Milliseconds 300",
  "}",
  "Start-Sleep -Milliseconds 500",
  "$appDir = Join-Path (Split-Path -Parent $AsarPath) 'app'",
  "$unpacked = $AsarPath + '.unpacked'",
  "$marker = Join-Path $appDir 'dsh\\node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "$markerNext = Join-Path $appDir 'node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "if ((Test-Path -LiteralPath $unpacked) -and -not ((Test-Path -LiteralPath $marker) -or (Test-Path -LiteralPath $markerNext))) {",
  "  & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null",
  "}",
  "$moved = -not (Test-Path -LiteralPath $AsarPath)",
  "$hadAsar = -not $moved",
  "$moveErr = ''",
  "if (Test-Path -LiteralPath $AsarPath) {",
  "  $bak = \"$AsarPath.bak\"",
  "  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
  "  for ($i = 0; $i -lt 80; $i++) {",
  "    try {",
  "      Move-Item -LiteralPath $AsarPath -Destination $bak -Force -ErrorAction Stop",
  "      $moveErr = ''",
  "      break",
  "    } catch {",
  "      $moveErr = $_.Exception.Message",
  "      if ($i -eq 20 -or $i -eq 50) { Stop-HarnessInstall; Start-Sleep -Seconds 1 }",
  "      Start-Sleep -Milliseconds 400",
  "    }",
  "  }",
  "  if ((Test-Path -LiteralPath $AsarPath) -and $moveErr) {",
  "    # Move-Item 偶尔报『拒绝访问』但其实只是句柄没释放；.NET 直调再试一次并保留真实错误。",
  "    try {",
  "      if (Test-Path -LiteralPath $bak) { [System.IO.File]::Delete($bak) }",
  "      [System.IO.File]::Move($AsarPath, $bak)",
  "      $moveErr = ''",
  "    } catch { $moveErr = $_.Exception.Message }",
  "  }",
  "  $moved = ($moveErr -eq '') -and (-not (Test-Path -LiteralPath $AsarPath))",
  "}",
  "$lock = $AsarPath + '.rename-pending'",
  "if ($moved) {",
  "  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue",
  "  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
  "  Write-SwapLog $(if ($hadAsar) { 'moved asar -> bak (verified)' } else { 'asar already absent' })",
  "  Start-Process -FilePath $ExePath",
  "} else {",
  "  # #197b: 挪不动（asar 仍被占用）时不要把用户扔在空桌面上——把原版拉起来，",
  "  # 留下 rename-pending 让下一次空闲重试；失败原因写进 dsh-purge 日志。",
  "  Set-Content -LiteralPath $lock -Value ((Get-Date).ToString('o')) -Encoding ascii",
  "  Write-SwapLog ('move failed: ' + $moveErr + '; relaunching original app (asar still sealed)')",
  "  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
  "  Start-Process -FilePath $ExePath",
  "}",
  "",
].join("\r\n");

const ASAR_RENAME_WHEN_IDLE_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][string]$AsarPath,",
  "  [Parameter(Mandatory = $true)][string]$ExePath,",
  "  [Parameter(Mandatory = $true)][string]$LockPath",
  ")",
  "$ErrorActionPreference = 'Continue'",
  "$deadline = (Get-Date).AddMinutes(30)",
  "$tries = 0",
  "while ((Get-Date) -lt $deadline) {",
  "  $restartFlag = Join-Path $env:TEMP 'dsh-purge-official-restarting'",
  "  if (Test-Path -LiteralPath $restartFlag) {",
  "    $flagAge = (Get-Date) - (Get-Item -LiteralPath $restartFlag).LastWriteTime",
  "    if ($flagAge.TotalSeconds -ge 0 -and $flagAge.TotalSeconds -lt 45) { exit 0 }",
  "    Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue",
  "  }",
  "  $holding = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $ExePath } catch { $false } })",
  "  if ($holding.Count -gt 0) { Start-Sleep -Milliseconds 500; continue }",
  "  if (-not (Test-Path -LiteralPath $AsarPath)) {",
  "    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "    exit 0",
  "  }",
  "  $appDir = Join-Path (Split-Path -Parent $AsarPath) 'app'",
  "  $unpacked = $AsarPath + '.unpacked'",
  "  $marker = Join-Path $appDir 'dsh\\node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "  $markerNext = Join-Path $appDir 'node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "  if ((Test-Path -LiteralPath $unpacked) -and -not ((Test-Path -LiteralPath $marker) -or (Test-Path -LiteralPath $markerNext))) {",
  "    & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null",
  "  }",
  "  $bak = \"$AsarPath.bak\"",
  "  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
  "  $tries++",
  "  try {",
  "    Move-Item -LiteralPath $AsarPath -Destination $bak -Force -ErrorAction Stop",
  "    $renameErr = ''",
  "  } catch { $renameErr = $_.Exception.Message }",
  "  if ($renameErr -or (Test-Path -LiteralPath $AsarPath)) {",
  "    try {",
  "      if (Test-Path -LiteralPath $bak) { [System.IO.File]::Delete($bak) }",
  "      [System.IO.File]::Move($AsarPath, $bak)",
  "      $renameErr = ''",
  "    } catch { $renameErr = $_.Exception.Message }",
  "  }",
  "  if (Test-Path -LiteralPath $AsarPath) {",
  "    if ($tries -eq 1 -or ($tries % 300) -eq 0) {",
  "      try { Add-Content -LiteralPath (Join-Path $env:TEMP 'dsh-purge-desktop.log') -Value ((Get-Date).ToUniversalTime().ToString('o') + ' [asar-idle] move failed: ' + $renameErr) } catch {}",
  "    }",
  "    Start-Sleep -Milliseconds 400",
  "    continue",
  "  }",
  "  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
  "  Start-Process -FilePath $ExePath",
  "  exit 0",
  "}",
  "Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "",
].join("\r\n");

/** 官方壳开着时 app.asar 被占用。不结束进程，等用户退出后再改名并重新打开。 */
export function canonicalWindowsExe(exe) {
  if (!exe || process.platform !== "win32") return exe;
  try {
    return fs.realpathSync(exe);
  } catch {
    return exe;
  }
}

export function scheduleAsarRenameWhenIdle({ exe, asar } = {}) {
  if (!exe || !asar) return { pending: false };
  exe = canonicalWindowsExe(exe);
  const lock = `${asar}.rename-pending`;
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age >= 0 && age < 30 * 60 * 1000) return { pending: true, already: true };
    // age<0 时钟回拨或 age>=30min stale，视为失效，清掉重做。
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  } catch {
    // 没有待处理标记，下面新建。
  }
  fs.writeFileSync(lock, `${Date.now()}\n`, "utf8");
  const script = path.join(os.tmpdir(), `dsh-purge-asar-rename-when-idle-${restartUniqSuffix()}.ps1`);
  fs.writeFileSync(script, ASAR_RENAME_WHEN_IDLE_PS1, "utf8");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-AsarPath",
      asar,
      "-ExePath",
      exe,
      "-LockPath",
      lock,
    ],
    { detached: true, stdio: "ignore", windowsHide: true, shell: false },
  );
  // detached spawn 的 ENOENT / 权限错误走 'error' 事件,没监听会 uncaught → 整个进程崩。
  child.on("error", (err) => {
    try { console.warn("[dsh-purge] asar rename idle PS1 spawn 失败:", err?.message || err); } catch { /* 忽略 */ }
  });
  child.unref();
  return { pending: true };
}

/** 等当前桌面进程退出后把 app.asar 挪走，再启动 exe。解开后的 resources/app 才会被加载。 */
export function scheduleAsarSwapRestart({ exe, asar, waitPid = process.pid, exit = false, runtime = null, ctx = null } = {}) {
  if (!exe || !asar) throw new Error("缺少桌面 exe 或 app.asar，无法重启");
  exe = canonicalWindowsExe(exe);
  // 若调用方没显式传 runtime,但传了 ctx —— 自己解析一次。
  // 让启动期自愈路径 (index.js:scheduleApplyRestart / 2004 自愈分支) 透传 ctx 就能走优雅握手。
  if (!runtime && ctx) {
    try { runtime = desktopRuntimeOf(ctx); } catch { /* ignore */ }
  }
  // #64 crash-dialog 根因:宿主 main.js:3725 ChildProcess listener 把 host 退出当
  // "host stopped" 弹崩溃对话框。双保险:
  //   1) PowerShell 立即 Stop-HarnessInstall (杀 Electron main + host),Electron
  //      还没来得及看到 host 退出事件就被 kill,UI 不存在,无法弹 crash dialog。
  //   2) runtime.requestRestart 存在就先 ack 一次,给宿主"预期退出"标记窗口(若有)。
  // host 自己的 process.exit 是最后兜底 —— 一般会先被 PowerShell kill。
  const gracefulExit = () => {
    if (!runtime) {
      // 没 runtime —— 短 timeout 给 PowerShell 启动完成的时间(实测 ~200-500ms),
      // 然后主动退出。PowerShell 会在这期间杀掉 Electron,即便 host 自己退出
      // Electron 也已经不在了,不会弹 dialog。
      logInternal("asar swap: no runtime handoff, relying on PowerShell to kill Electron first");
      setTimeout(() => { try { process.exit(0); } catch {} }, 1500);
      return;
    }
    logInternal("asar swap: handing off restart to desktopRuntime");
    try {
      // #64:requestRestart 可能"空返回"但副作用也许仍标记预期退出,双保险之一。
      Promise.resolve(runtime.requestRestart()).catch((err) => {
        logInternal("desktopRuntime.requestRestart rejected: " + (err?.message || err));
      });
    } catch (err) {
      logInternal("desktopRuntime.requestRestart threw: " + (err?.message || err));
    }
    // 2000ms 兜底:给宿主 requestRestart 做完 + PowerShell 启动完成。
    // 即便两条路径都挂,PowerShell 也会在 ~500ms 内 kill Electron,不会弹 crash。
    setTimeout(() => {
      try { process.exit(0); } catch {}
    }, 2000);
  };

  const script = path.join(os.tmpdir(), `dsh-purge-asar-swap-${process.pid}.ps1`);
  fs.writeFileSync(script, ASAR_SWAP_PS1, "utf8");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-WaitPid",
      String(waitPid),
      "-AsarPath",
      asar,
      "-ExePath",
      exe,
    ],
    { detached: true, stdio: "ignore", windowsHide: true, shell: false },
  );
  // 没挂 'error' listener,PowerShell 不在 PATH / 被 AV 拦就是 unhandled 'error' event,
  // 会被 Node 当 uncaughtException 直接把宿主崩掉。
  child.on("error", (err) => {
    logInternal("asar swap PowerShell spawn failed: " + (err?.message || err));
  });
  child.unref();
  if (exit !== false) gracefulExit();
  return { scheduled: true };
}

/**
 * 点「应用」之后走哪条重启。#64：宿主 requestRestart 在桌面端会空返回，进程不动。
 * Windows 官方包用 wscript 结束再打开。Linux / macOS 能定位到 exe 就走 restart-desktop.js。
 */
export function desktopRestartChoice(input = {}) {
  const exe = input.exe || "";
  const desktopExe = Boolean(exe && isDesktopExecutable(exe));
  if (input.openBrowser === false) return "skip";
  if (desktopExe && input.asarSealed === true) return "asar-swap";
  if (desktopExe) return "helper";
  if (input.hasRuntime) return "request-restart";
  return "helper";
}


function officialExeFromProcess() {
  if (isOfficialHarnessExecutable(process.execPath) && isFile(process.execPath)) {
    return path.normalize(process.execPath);
  }
  const resources = process.resourcesPath;
  if (!resources) return "";
  const hit = firstExistingExe([path.dirname(path.normalize(resources))]);
  if (hit && isOfficialHarnessExecutable(hit)) return hit;
  return "";
}


export function scheduleRestart(request, ctx, options = {}) {
  // 启动自检会带 openBrowser:false。桌面进程不再因此杀掉自己。
  if (options.openBrowser === false) return { restarting: false, skipped: true };
  const exe =
    officialExeFromProcess() ||
    findDesktopAppExecutable() ||
    "";
  const asar = exe ? appAsarPath(exe) : "";
  if (exe && asar && asarArchiveIsFile(asar)) {
    const runtime = desktopRuntimeOf(ctx);
    scheduleAsarSwapRestart({ exe, asar, waitPid: process.pid, exit: true, runtime });
    return { restarting: true, asarSwap: true };
  }
  const runtime = desktopRuntimeOf(ctx);
  const choice = desktopRestartChoice({
    exe,
    asarSealed: false,
    hasRuntime: Boolean(runtime),
  });
  if (choice === "helper" && exe && isDesktopExecutable(exe)) {
    const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
    try {
      spawnHelper(helper, {
        respawn: true,
        killApp: true,
        execPath: exe,
        cwd: path.dirname(exe),
      }, { exit: false });
    } catch (error) {
      return {
        restarting: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { restarting: true };
  }
  if (runtime) {
    // 只走桌面整应用 relaunch，不要 exit Host（那会先把内嵌 web 单独拉起来）。
    Promise.resolve(runtime.requestRestart()).catch((err) => {
      logInternal("desktop requestRestart failed: " + (err?.message || err));
    });
    return { restarting: true };
  }
  const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
  // 没定位到 exe 时不杀进程：helper 现在按 exe 路径筛选，没有路径就找不到任何目标，
  // 继续传 killApp:true 只会让 helper 空跑。
  spawnHelper(helper, { respawn: true, killApp: Boolean(exe) }, { exit: false });
  return { restarting: true };
}

