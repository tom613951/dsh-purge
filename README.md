# dsh-purge (Enhanced Maintenance Fork)

DeepSeek Harness 协议层清洗与解除限制增强插件，支持官方桌面端、Web 端及 DSH NEXT 社区桌面版。

---

## 项目说明

本仓库为 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 的定制维护版本，专注于跨平台宿主适配、运行时容错增强以及关键缺陷修复。

### 核心特性与修复

- **DSH NEXT 原生适配**：完整支持 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 社区桌面版（可执行文件 `DSH NEXT.exe`，安装路径 `%LOCALAPPDATA%\Programs\DSH NEXT`）的宿主识别、ASAR 自动化解包修补与进程生命周期管理。
- **提示词模板安全脱水**：清除已弃用的 `{{cwd}}` 模板插值变量，消除新版 Harness 在模板装配阶段因未注册变量抛出未捕获异常导致对话会话中断的问题。
- **Node.js 兜底解压目录条目修复（PR #171）**：规范化处理以斜杠结尾的显式目录条目，建立真实目录而非空文件，消除子文件创建时触发的 `EEXIST` 异常。
- **Skills 模块软链真实路径守卫修复（PR #173）**：补齐 `lib/skills.js` 缺失的原生 `node:fs` 导入，恢复软链真实路径解析与源目录防误删机制。
- **控制台注入权限防护**：增加写入权限异常捕获，避免在权限受限的 Windows 目录下抛出 `EPERM` 异常导致主进程启动终止。

---

## 适配范围

| 宿主类型 | 可执行程序 / 路径特征 | 适配状态 |
|:---|:---|:---:|
| **DSH NEXT**（社区桌面版） | `DSH NEXT.exe` (`Programs\DSH NEXT`) | 原生支持 |
| **DeepSeek Harness**（官方桌面版） | `DeepSeek Harness.exe` / `DSH Desktop.exe` | 完整支持 |
| **DSH Web / CLI** | `@deepseek-ai/core` / `web` profile | 完整支持 |

---

## 安装与配置

在对应 profile 目录（例如 `~/.dsh/profiles/desktop/package.json`）的 `dependencies` 中添加：

```json
{
  "dependencies": {
    "dsh-purge": "https://codeload.github.com/tom613951/dsh-purge/tar.gz/refs/heads/master"
  }
}
```

随后在 profile 目录下执行安装：

```bash
pnpm install
```

---

## 常用指令

### 聊天对话指令

在会话输入框中直接输入：

| 指令 | 说明 |
|:---|:---|
| `/purge` 或 `/dsh-purge` | 查看插件当前运行态、宿主环境与补丁生效情况 |
| `/purge apply` | 触发 ASAR 解包并应用清洗规则 |
| `/purge revert` | 还原宿主原始代码并撤销注入 |
| `/purge restart` | 平滑重启宿主桌面客户端 |

### 命令行（CLI）

```bash
# 查看宿主检测状态与规则详情
dsh-purge --status

# 离线应用补丁
dsh-purge --apply

# 撤销补丁还原
dsh-purge --revert
```

---

## 许可证与致谢

- 本项目基于 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 进行二开与维护。
- 遵循 [Apache-2.0 License](LICENSE)。
