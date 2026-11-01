# ⚔️ dsh-purge (Enhanced Maintenance Fork)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-98%20passed%2C%200%20failed-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-339933.svg)]()
[![DSH Compatibility](https://img.shields.io/badge/DSH-0.2.0%20%7C%200.2.1--rc.2%20%7C%20DSH%20NEXT-blue.svg)]()
[![Encoding](https://img.shields.io/badge/encoding-UTF--8%20(No%20BOM)-success.svg)]()

DeepSeek Harness 协议层清洗、运行态加固与红队安全演练增强插件。本仓库为针对官方桌面端、Web 端及社区版 **DSH NEXT** 进行工程级深度加固与跨版本融合的长期维护分支。

---

## 📌 项目定位与融合背景

本维护分支基于上游 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 演进，针对历史版本断代、上游删库遗失资产以及 Windows 全球语言环境下的编码缺陷进行了系统性重构与融合：

1. **补全 1.1.71 删库断代核心资产**：完整恢复并洗净了原作者在 1.1.71 版本中沉淀的 **23 项体系化实战红队攻防技能库**，并在现代插件架构中重构了随包自动发现、校验与分发机制。
2. **完全对齐 1.1.86 最新宿主防御机制**：深度集成上游在 v1.1.86 引入的 Web 端口释放回收（防 PID 复用误杀）、桌面端 ASAR 瞬态重命名备份互斥保护、深色模式高对比度视觉缺陷修复等核心补丁。
3. **原生兼容 Windows UTF-8 全球语言环境**：全面排查并根除历史更新记录中的 Mojibake 双重编码乱码与 `\ufffd` 损坏字符，全仓库统一执行严格的 UTF-8（无 BOM）标准，原生兼容开启「Beta 版: 使用 Unicode UTF-8 提供全球语言支持」的操作系统环境。
4. **包管理器工程规范自愈**：消除 pnpm 11+ 下因 URL 键值导致 `allowBuilds` 构建拦截的问题，内置配置文件格式自愈与提示词装配熔断兜底。

---

## 🚀 核心架构与功能矩阵

### 1. 23 项体系化随包攻防技能矩阵（1.1.71 完整版）

插件随包内置 23 项完整的红队攻防演练技能，由 `lib/redteam/index.js`（`installBundledSkills`）在宿主启动或配置阶段自动同步至 `$DSH_HOME/redteam/skills`，开箱即用：

| 阶段领域 | 技能标识 | 能力与覆盖说明 |
|:---|:---|:---|
| **资产测绘与侦察** | `passive-recon` | 被动信息收集：纯公开数据源检索，零网络触碰 |
| | `asset-correlation` | 资产拓扑图谱化：域名 ↔ IP ↔ C 段 ↔ 证书 ↔ 端口服务关联 |
| | `recon-pipeline` | ProjectDiscovery 自动化流水线（subfinder → dnsx → naabu → httpx → katana） |
| | `fofa-recon` | FOFA API 批量空间测绘：内置限速防封、单线程队列与指数退避重试 |
| | `web-fingerprint` | Web 服务指纹探测：框架、中间件、CMS 及组件细粒度版本识别 |
| **脆弱性发现与探测** | `active-scan` | 主动端口与服务扫描（nmap / masscan），严格遵循授权边界 |
| | `dir-bruteforce` | 目录与文件深度爆破（ffuf / feroxbuster / dirsearch / gobuster） |
| | `nuclei-scan` | 自动化模板扫描：13,000+ 模板覆盖 CVE、暴露面与默认口令探测 |
| | `unauth-exploit` | 常见服务未授权访问与信息泄露利用链（Redis/MySQL/ES/Docker/MongoDB） |
| **内网横向与凭据** | `fscan-intranet` | fscan 内网综合快速扫描：弱口令爆破、MS17-010/SMBGhost、Redis 利用与隧道 |
| | `gogo-intranet` | gogo 高性能低噪声内网扫描引擎：动静态指纹提取、Nuclei POC 集成 |
| | `lateral-movement` | 域内横向移动与提权：Impacket 套件（PtH/PsExec/WMI/DCOM/Kerberos/凭据转储） |
| | `credential-attack` | 凭据攻击：Hydra 在线服务爆破与 Hashcat/John 离线密码哈希破解 |
| **网络隧道与代理穿透** | `frp-tunnel` | FRP 内网穿透：多级节点端口映射与稳定反向 SOCKS5 代理隧道 |
| | `chisel-tunnel` | Chisel 隧道：基于 HTTP/WebSocket 封装的多路复用穿透通道 |
| | `suo5-tunnel` | suo5 内存隧道：基于 WebShell HTTP 流量的全双工高性能 SOCKS5 代理 |
| | `cn-proxy-pool` | 免费代理池动态爬取与验活：命令级按需轮换，严禁污染系统全局代理 |
| **会话维持与自动化** | `webshell-toolkit` | 冰蝎 (Behinder) / 哥斯拉 (Godzilla) / 中国蚁剑 (AntSword) 综合会话管理 |
| | `shell-handler` | VPS / 本地反弹 Shell 监听调度（MSF / nc / socat）与自动化载荷投递 |
| | `vps-reverse-shell` | 专用 VPS 反向中转通道：安全端口监听、非交互会话接管与流量转发 |
| | `browser-automation` | 无依赖 Headless Chrome / Playwright 浏览器自动化执行与 DOM 取证 |
| | `kimi-webbridge` | 浏览器扩展级真实会话驱动：操作当前已登录页面、填表、取证与快照 |
| | `redteam-setup` | 首次演练初始化向导：通道基准测试、API Key 校验与工具链可用性验证 |

### 2. 宿主适配与环境兼容

| 宿主环境 | 可执行路径 / 标识特征 | 适配策略与状态 |
|:---|:---|:---:|
| **DSH NEXT**（社区桌面版） | `DSH NEXT.exe` (`%LOCALAPPDATA%\Programs\DSH NEXT`) | **原生支持**：自动解包 ASAR，管理独立主进程与互斥锁 |
| **DeepSeek Harness**（官方桌面版） | `DeepSeek Harness.exe` / `DSH Desktop.exe` | **完整支持**：识别官方打包环境，安全注入补丁 |
| **DeepSeek Harness Web** | `@deepseek-ai/core` / `dsh web` | **完整支持**：EADDRINUSE 自动回收与端口退避防误杀 |

### 3. 运行态安全防线与加固特性 (v1.1.86 对齐)

- **EADDRINUSE 进程精准回收**：Web 启动前主动探测目标监听端口，结合 `netstat` / `lsof` 校验监听进程命令行，严禁在未确认监听身份时盲杀外部进程；支持 PID 复用规避与端口释放等待。
- **ASAR 瞬态重命名备份机制**：修补前将目标 `app.asar` 先行重命名为 `app.asar.dshpurge.bak`，写入新文件失败时强制回滚，防止进程抢占导致宿主文件破坏。
- **深色主题高对比度修复**：修复深色模式下操作按钮近白色背景导致文字不可读的问题，优化分析报告步骤序号圆点样式，保持界面视觉一致性。
- **模板插值熔断守卫**：在提示词装配前过滤失效的 `{{cwd}}` 占位符，消除因上下文变量缺失导致的运行时未捕获异常。
- **pnpm 11+ 配置自愈**：针对 `pnpm-workspace.yaml` 中的 `allowBuilds` 规则进行动态清洗，自动剥离 URL 依赖键并规范化为裸包名，保障 `postinstall` 零阻碍执行。

---

## 🛠️ 安装与配置指南

### 1. 桌面端集成 (DeepSeek Harness / DSH NEXT)

编辑你的 Profile 依赖配置（例如 `~/.dsh/profiles/desktop/package.json`），在 `dependencies` 中添加：

```json
{
  "dependencies": {
    "dsh-purge": "https://codeload.github.com/tom613951/dsh-purge/tar.gz/refs/heads/master"
  }
}
```

> **提示**：若需要锁定特定审计版本，可将 `refs/heads/master` 替换为具体的 Commit SHA。

在 Profile 目录下执行安装：

```powershell
pnpm --prefix ~/.dsh/profiles/desktop install
```

### 2. Web 端集成 (`dsh web`)

在 Web Profile 目录下执行添加：

```bash
dsh plugin --profile web add https://codeload.github.com/tom613951/dsh-purge/tar.gz/refs/heads/master
```

---

## 💻 指令速查

### 对话内交互指令

在 Harness 会话窗口中直接输入：

| 指令 | 作用与执行动作 |
|:---|:---|
| `/purge` 或 `/dsh-purge` | 查看当前插件运行状态、宿主版本及 71 条清洗规则就绪情况 |
| `/purge apply` | 触发宿主 ASAR 自动化解包、规则注入与安全加固 |
| `/purge revert` | 撤销注入规则，完整还原宿主原始备份文件 |
| `/purge restart` | 安全终止并平滑重启宿主桌面客户端或后台服务 |

### 终端 CLI 指令

```bash
# 检查宿主探测状态、ASAR 状态与规则就绪度
dsh-purge --status

# 离线执行规则注入
dsh-purge --apply

# 离线回滚所有修改
dsh-purge --revert
```

---

## 🔬 验证与质量保证

本项目遵循严谨的测试驱动开发（TDD）与持续集成标准，所有代码变更均通过严格的语法检查与自动化测试断言：

```bash
# 运行单元测试套件（98 项用例）
npm test

# 执行核心模块语法合规性检查（80 个源文件）
node --check lib/index.js
node --check lib/core.js
node --check lib/surface.js
node --check lib/web.js
node --check lib/desktop.js
node --check lib/host.js
node --check lib/rewind.js
node --check lib/skills.js
node --check client.js
```

**实测结果基线**：
- **测试通过率**：`98 pass, 0 fail`（涵盖随包技能自动发现、UTF-8 字符合法性、ASAR 锁保护、端口监听解析、自愈配置重写等）。
- **编码合规性**：全量文件 UTF-8 无 BOM，零非法替换符，零 Mojibake 损坏。

---

## ⚖️ 免责声明与版权规范

1. **上游致敬与渊源**：本项目核心逻辑与基础设计源自 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)。本维护分支严格遵守原作者开源协议与署名要求，保留所有原始许可证与版权声明。
2. **合法授权与安全边界**：本工具仅限用于**本地受控实验室环境（RFC1918 私有地址空间 / 127.0.0.1 回环网络）**以及已获得明确书面授权的网络安全演练、渗透测试与攻防教学。严禁用于非法未授权探测、网络黑灰产以及任何违反法律法规的活动。
3. **开源协议**：本项目依据 [Apache-2.0 License](LICENSE) 开源发布。
