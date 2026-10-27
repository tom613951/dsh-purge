# dsh-purge (Enhanced Maintenance Fork)

A runtime protocol sanitization and unconstrained environment enhancement plugin for DeepSeek Harness, supporting official desktop builds, web profiles, and the DSH NEXT community desktop edition.

[English](README.md) | [中文](README.zh-CN.md)

---

## Overview

This repository is a customized maintenance fork of [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), focused on cross-platform host compatibility, runtime fault tolerance, and critical bug fixes.

### Key Enhancements & Bug Fixes

- **DSH NEXT Compatibility**: Native host detection, automated ASAR unpacking/patching, and clean lifecycle management for the [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) community build (`DSH NEXT.exe`, located at `%LOCALAPPDATA%\Programs\DSH NEXT`).
- **Prompt Sanitization & Crash Guard**: Deprecated `{{cwd}}` template interpolation variables have been eliminated, preventing unhandled runtime exceptions during prompt assembly on newer Harness versions.
- **Node.js Fallback Unzip Directory Handling (PR #171)**: Explicit directory entries ending with slashes now create actual directories rather than zero-byte files, resolving `EEXIST` collision errors during subsequent file extraction.
- **Skills Module Symlink Guard Resolution (PR #173)**: Restored the missing `node:fs` module import in `lib/skills.js`, ensuring realpath resolution executes properly to protect source directories from accidental deletion.
- **Console Injection Permission Resilience**: Added defensive exception handling around filesystem operations to prevent process termination on Windows `EPERM` errors.

---

## Compatibility Matrix

| Host Environment | Executable / Path Pattern | Support Status |
|:---|:---|:---:|
| **DSH NEXT** (Community Build) | `DSH NEXT.exe` (`Programs\DSH NEXT`) | Native Support |
| **DeepSeek Harness** (Official Desktop) | `DeepSeek Harness.exe` / `DSH Desktop.exe` | Full Support |
| **DSH Web / CLI** | `@deepseek-ai/core` / `web` profile | Full Support |

---

## Installation & Configuration

Add this repository to your target profile's `package.json` (e.g. `~/.dsh/profiles/desktop/package.json`):

```json
{
  "dependencies": {
    "dsh-purge": "https://codeload.github.com/tom613951/dsh-purge/tar.gz/refs/heads/master"
  }
}
```

Then run pnpm install inside the profile directory:

```bash
pnpm install
```

---

## Usage

### Chat Commands

| Command | Description |
|:---|:---|
| `/purge` or `/dsh-purge` | Inspect current runtime status, host detection, and patch status |
| `/purge apply` | Trigger ASAR unpacking and apply sanitization patches |
| `/purge revert` | Restore host files to their unpatched state |
| `/purge restart` | Gracefully restart the desktop client process |

### Command Line Interface (CLI)

```bash
# Check host status and patch rules
dsh-purge --status

# Apply patches offline
dsh-purge --apply

# Revert patches
dsh-purge --revert
```

---

## License & Attribution

- Forked and maintained based on [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge).
- Licensed under the [Apache-2.0 License](LICENSE).
