# 1.2.7

## 中文

- **仓库精简与适配同步**：
  - 精简 `README.md` 为双节结构（项目定位与关联项目），对齐本地 DSH NEXT（`0.2.2-rc.1` / `rc.2`）维护定位。
  - 删除 `docs/notice/`、`docs/preview/`、`docs/v1.1.34-prompt-inject.md`、`docs/banner.svg`、`screenshots.json` 与 `LICENSE-COMMERCIAL.md` 等冗余历史文档及资源，保留 `docs/drill-auth-legal.html` 与红队上游声明文件；清理 `package.json` 与 `lib/update.js` 中的 `screenshots.json` 引用。
  - 精简 `release-notes.md` 历史体积，更新 `.github/workflows/release.yml` 仓库校验与 `npm test` 门禁。
- **核心补丁清理与 CLI 桌面模式自动识别**：
  - 移除 `lib/core.js` 中不适用的第三方 `liangshen` 及 `preset-unrestricted` 相关补丁（`#76`、`#71`、`#28`）与辅助函数，同步收敛 `#24`、`#43` 与 `targetFiles`，保留 `silenceOfficialPhase1Strip`、`#40`、`#47`、`#49`、`#80` 及 `hooksDenyBypass` 链路。
  - 在 `bin/dsh-purge.js` 增加桌面版单端自动识别：当未显式指定 `DSH_SURFACE` 且仅存在 `profiles/desktop/package.json`、不存在 `profiles/web/package.json`、且能探测到桌面可执行文件时自动启用 `DSH_SURFACE=desktop`。

## English

- **Repository Pruning & Metadata Sync**:
  - Simplified `README.md` to a concise two-section fork overview aligned with local DSH NEXT (`0.2.2-rc.1` / `rc.2`) maintenance.
  - Removed unused historical docs and assets (`docs/notice/`, `docs/preview/`, `docs/v1.1.34-prompt-inject.md`, `docs/banner.svg`, `screenshots.json`, `LICENSE-COMMERCIAL.md`) while keeping `docs/drill-auth-legal.html` and upstream redteam license/disclosure files; removed `screenshots.json` from `package.json` and `lib/update.js`.
  - Trimmed `release-notes.md` and updated `.github/workflows/release.yml` repository check, printed release URL, and `npm test` gate.
- **Core Patch Pruning & CLI Desktop Surface Auto-Detection**:
  - Removed non-applicable `liangshen` and `preset-unrestricted` patches (`#76`, `#71`, `#28`) and helper functions from `lib/core.js`, updated `#24`, `#43`, and `targetFiles`, and retained `silenceOfficialPhase1Strip`, `#40`, `#47`, `#49`, `#80`, and `hooksDenyBypass`.
  - Added desktop-only auto-detection in `bin/dsh-purge.js` when `DSH_SURFACE` is unset and `profiles/desktop/package.json` is present without `profiles/web/package.json` alongside a valid desktop executable.

# 1.2.6

## 中文

- **DSH `0.2.2-rc.2` 兼容与预设能力探测**：
  - 为补丁 `#13`、`#18`、`#35` 与 `#62` 追加 `0.2.2-rc.2` 兼容匹配并保留 `0.2.2-rc.1` 支持；新增 `lib/preset-compat.js` 接入预设能力探测与迁移。
- **Zip / ASAR 安全加固与上下文微调**：
  - 收口 `lib/zip-extract.js` 严格边界校验，强化 `lib/extract-asar.js` / `lib/core.js` 原子恢复；新增 `isSafetyOnlySection`、`/dsh-purge/tuning` 与 `/purge safety` / `/purge anchor` 运行时微调。

## English

- **DSH `0.2.2-rc.2` Compatibility & Preset Capability Probing**:
  - Added additive `0.2.2-rc.2` patterns for patches `#13`, `#18`, `#35`, and `#62` while retaining `0.2.2-rc.1` support; added `lib/preset-compat.js` for preset capability probing and migration.
- **Safe Zip/ASAR Extraction & Runtime Context Tuning**:
  - Hardened `lib/zip-extract.js` boundary checks and atomic ASAR staging recovery; added `isSafetyOnlySection`, `/dsh-purge/tuning`, and `/purge safety` / `/purge anchor`.
