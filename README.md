# dsh-purge (Enhanced Maintenance Fork)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-98%20passed%2C%200%20failed-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-339933.svg)]()
[![DSH Compatibility](https://img.shields.io/badge/DSH-0.2.0%20%7C%200.2.1--rc.2~rc.5%20%7C%20DSH%20NEXT-blue.svg)]()
[![Encoding](https://img.shields.io/badge/encoding-UTF--8%20(No%20BOM)-success.svg)]()

DeepSeek Harness 协议层清洗、运行态加固与安全演练扩展插件。本仓库为面向官方桌面版、Web 版及社区版 DSH NEXT 的工程化维护分支。

---

## 项目背景与定位

本维护分支基于上游 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 演进，旨在解决历史版本迭代中的资产断代、现代宿主运行时防护缺陷以及跨平台环境下的字符编码问题：

1. **版本资产融合**：完整恢复 1.1.71 版本的 23 项实战攻防演练技能，并在现代插件架构中重构随包自动校验与分发机制。
2. **宿主防护对齐**：完全合入 1.1.88 版本的运行态防护机制与 rc.2/rc.4/rc.5 多版本适配架构，包含 Web 服务端口安全回收（防 PID 复用误杀）、桌面端 ASAR 瞬态重命名备份互斥保护、原子写保护、审批白名单放行及深色主题界面适配。
3. **字符编码基线**：全仓库严格遵循 UTF-8（无 BOM）标准，彻底清理历史记录中的 Mojibake 乱码与替换字符，原生兼容 Windows 系统的 UTF-8 全球语言支持环境。
4. **包管理规范自愈**：针对 pnpm 11+ 环境自动修正 `allowBuilds` 配置格式，消除 URL 依赖导致的构建拦截，实现 postinstall 零干预执行。

---

## 系统架构与特性

### 1. 随包实战技能矩阵

插件内置 23 项标准技能规范文件，由 `lib/redteam/index.js` 在宿主启动阶段自动校验并同步至 `$DSH_HOME/redteam/skills`：

| 阶段分类 | 技能标识 | 功能描述 |
|:---|:---|:---|
| 资产测绘与侦察 | `passive-recon` | 被动信息收集：利用公开网络源进行情报检索，不产生直接网络通信 |
| | `asset-correlation` | 资产关联分析：构建域名、IP、C 段、数字证书与服务端口的拓扑图谱 |
| | `recon-pipeline` | 自动化侦察流：串联 subfinder、dnsx、naabu、httpx 与 katana 展开资产面 |
| | `fofa-recon` | 网络空间测绘：FOFA API 批量资产检索，内置请求限速与指数退避重试 |
| | `web-fingerprint` | Web 指纹识别：识别底层框架、中间件、CMS 架构及组件版本号 |
| 脆弱性检测与利用 | `active-scan` | 主动服务探测：基于 nmap 与 masscan 执行受限网段的端口与服务识别 |
| | `dir-bruteforce` | 目录与文件爆破：针对敏感路径、备份文件与接口暴露面的枚举探测 |
| | `nuclei-scan` | 模板化漏洞扫描：集成 13,000+ 社区规则，覆盖已知 CVE 与配置缺陷检测 |
| | `unauth-exploit` | 未授权访问利用：检测并验证数据库、缓存与容器等基础服务的访问控制缺陷 |
| 内网评估与凭据分析 | `fscan-intranet` | 内网综合扫描：存活探测、高危漏洞检测、常见协议弱口令验证与隧道调度 |
| | `gogo-intranet` | 高性能内网探测：指纹特征比对、关键资产元数据提取与 Nuclei 规则联动 |
| | `lateral-movement` | 横向移动与权限提升：Impacket 工具集调用、认证协议分析与凭据提取 |
| | `credential-attack` | 凭据安全性评估：基于 Hydra 的网络服务在线爆破与离线密码哈希分析 |
| 网络隧道与传输中继 | `frp-tunnel` | 反向穿透隧道：通过 FRP 架构建立多级端口映射与稳定 SOCKS5 代理通道 |
| | `chisel-tunnel` | 传输层多路复用：基于 HTTP/WebSocket 协议封装的高穿透性安全隧道 |
| | `suo5-tunnel` | 内存双工隧道：通过 WebShell HTTP 流量构建的高吞吐量 SOCKS5 代理 |
| | `cn-proxy-pool` | 动态代理调度：仅通过命令级代理参数调度网络出口，不改写操作系统全局网络配置 |
| 会话控制与自动化 | `webshell-toolkit` | 远端管理协议对接：支持主流 WebShell 通信协议与会话持久化维护 |
| | `shell-handler` | 反弹通道调度：本地与 VPS 监听端口分配、会话维持与载荷自动化交付 |
| | `vps-reverse-shell` | 中继管道管理：基于受控 VPS 节点的反向隧道维持与非交互流量转发 |
| | `browser-automation` | 无界面浏览器驱动：基于 Headless 模式进行 DOM 树渲染、交互验证与取证 |
| | `kimi-webbridge` | 浏览器扩展驱动：复用宿主已鉴权会话环境进行页面操作与证据捕获 |
| | `redteam-setup` | 初始化向导：验证评估环境网络可达性、API 凭证有效性与底层依赖状态 |

### 2. 宿主兼容矩阵

| 宿主类型 | 二进制 / 路径特征 | 支持状态与技术实现 |
|:---|:---|:---:|
| DSH NEXT（社区版） | `DSH NEXT.exe` (`%LOCALAPPDATA%\Programs\DSH NEXT`) | 原生支持：支持独立主进程识别、ASAR 自动化解包与补丁注入 |
| DeepSeek Harness（官方桌面版） | `DeepSeek Harness.exe` / `DSH Desktop.exe` | 完整支持：识别官方打包环境，安全注入补丁 |
| DeepSeek Harness Web | `@deepseek-ai/core` / `dsh web` | 完整支持：支持 0.2.1-rc.2 ~ rc.5 多版本自适应、EADDRINUSE 自动检测与端口释放机制 |

### 3. 运行态安全加固

- **端口安全释放**：Web 服务启动前执行端口状态检测，结合系统网络状态表（`netstat` / `lsof`）校对目标进程标识，杜绝在未核验命令行特征时终止外部无关进程；提供端口释放等待与重试机制。
- **ASAR 瞬态原子备份**：修补前将 `app.asar` 备份为 `app.asar.dshpurge.bak`，写入异常时自动触发回滚流程，避免因文件并发抢占造成宿主程序损坏。
- **界面高对比度适配**：修复暗色主题下主操作按钮的反白不可读问题，调整报表节点样式，保证不同显示模式下的视觉层级一致。
- **模板解析异常熔断**：在提示词拼接阶段剔除未注册的 `{{cwd}}` 占位符，防御因模板变量未定义引发的主进程未捕获异常。
- **构建配置自愈机制**：动态修正 `pnpm-workspace.yaml` 中的 `allowBuilds` 字段，剔除 URL 依赖键并收敛至裸包名规范，保障自动化依赖安装流程正常完成。

---

## 安装与配置

### 1. 桌面端集成 (DeepSeek Harness / DSH NEXT)

在目标 Profile 配置文件（如 `~/.dsh/profiles/desktop/package.json`）的 `dependencies` 字段中声明：

```json
{
  "dependencies": {
    "dsh-purge": "https://codeload.github.com/tom613951/dsh-purge/tar.gz/refs/heads/master"
  }
}
```

执行安装以拉取依赖并触发 postinstall 配置注入：

```powershell
pnpm --prefix ~/.dsh/profiles/desktop install
```

### 2. Web 端集成 (`dsh web`)

在 Web Profile 目录下通过 CLI 添加插件依赖：

```bash
dsh plugin --profile web add https://codeload.github.com/tom613951/dsh-purge/tar.gz/refs/heads/master
```

---

## 指令与接口规范

### 会话交互指令

在对话会话输入窗口直接执行：

| 指令 | 作用与执行语义 |
|:---|:---|
| `/purge` 或 `/dsh-purge` | 查询当前运行环境信息、宿主类型及 71 条清洗规则就绪状态 |
| `/purge apply` | 执行宿主环境 ASAR 自动化解包、补丁写入与规则加载 |
| `/purge revert` | 撤销所有注入规则，从备份文件完整还原原始宿主程序 |
| `/purge restart` | 安全终止当前宿主进程并平滑拉起新实例 |

### 命令行接口 (CLI)

```bash
# 查询当前宿主环境状态与规则应用情况
dsh-purge --status

# 离线执行规则应用
dsh-purge --apply

# 离线还原宿主文件
dsh-purge --revert
```

---

## 验证与测试基准

本项目采用自动化回归测试与静态语法检查作为工程准入基线：

```bash
# 执行自动化单元测试套件
npm test

# 核心模块静态语法合规性检查
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

测试基线指标：
- 单元测试：98 项用例全量通过（覆盖随包技能校验、UTF-8 字符合法性、ASAR 锁保护、端口监听解析、自愈配置重写等）。
- 静态解析：全量代码通过 AST 语法解析，零语法错误，零警告。
- 字符编码：全量文本文件严格采用 UTF-8（无 BOM），无任何损坏字符或双重编码乱码。

---

## 安全边界与版权合规

1. **项目渊源**：本项目核心架构与实现基于 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)。本维护分支严格遵循开源许可要求，完整保留原始项目声明与版权归属。
2. **应用边界**：本工具仅供技术研究、安全评估以及在获得明确书面授权范围内的靶标演练使用。受控环境应限定于 RFC1918 私有地址段与本地回环接口，严禁用于未授权探测或破坏性网络攻击。
3. **开源协议**：本项目基于 [Apache-2.0 License](LICENSE) 授权开源。
