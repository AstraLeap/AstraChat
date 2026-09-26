# AstraChat (AC) v0.1.0

> 星辰跃动工作室出品的轻量级多模型 AI 聊天客户端 —— 「Cherry Studio 的加强版、WorkBuddy 的青春版」。

AstraChat 是一个完全自研的桌面 AI 聊天客户端：多模型聊天、人格/提示词管理、对话持久化、
QQ bot 接入配置管理。刻意**去掉办公套件**，保持轻量。

- 许可证：**MIT**（见 [LICENSE](LICENSE)）
- 定位：独立客户端，**不是**任何编辑器的插件
- 运行时：Electron 44 / Node 22+ / Chromium

---

## ✨ 功能（v0.1.0 范围）

| 模块 | 说明 |
|------|------|
| **多模型配置管理** | 任意多个 OpenAI 兼容提供商：名称 / Base URL / API Key / 默认模型，增删改查持久化到 SQLite；内置 10 个常见提供商预设（DeepSeek、OpenAI、Anthropic、Gemini、GLM、Qwen、Kimi、硅基流动、Ollama、自定义）一键填充 |
| **聊天界面** | 左侧对话列表（新建 / 重命名 / 删除 / 切换）、右侧消息气泡、流式输出、Markdown 渲染 + 代码高亮、Enter 发送 / Shift+Enter 换行 |
| **对话持久化** | 全部对话与消息落 SQLite；支持按关键词搜索（标题 + 消息正文），启动自动加载最近对话 |
| **人格与提示词** | 角色 = 名称 + 头像 + 系统提示词；对话可绑定角色，发送时自动注入系统提示词；内置 4 个示例角色 |
| **QQ bot 接入管理** | AppID / AppSecret / Token、「已发现的来源」逐条授权、白名单 / 审计 / 节流策略、连接状态 UI 与配置存储。**当前版本仅存储配置，不建立真实连接**（v0.2.0 走官方 Bot API，见 [设计文档](docs/qq-integration-design.md)） |

---

## 🧱 技术栈

| 层 | 选型 |
|----|------|
| 桌面框架 | Electron 44 |
| 前端 | React 19 + TypeScript + Vite 8 |
| 样式 | Tailwind CSS v4（+ CSS 变量设计令牌） |
| 数据存储 | SQLite via `better-sqlite3` 13 |
| 状态管理 | Zustand 5 |
| 打包 | electron-builder 26 |
| 测试 | Vitest 5 |

---

## 🚀 快速开始

```sh
npm install          # 安装依赖（会自动确保 Electron 运行时二进制就位）
npm run dev          # 开发模式：Vite dev server + Electron（带 HMR）
npm start            # 生产形态：先构建再用打包产物启动
```

### 全部脚本

| 命令 | 作用 |
|------|------|
| `npm run dev` | 开发模式（Vite dev server + Electron，主进程有改动需重跑） |
| `npm run build` | 构建主进程（esbuild）+ 渲染进程（Vite） |
| `npm run typecheck` | 对主进程与渲染进程分别跑 `tsc --noEmit` |
| `npm test` | Vitest 单元测试（数据层 / SSE 解析 / 流式客户端 / 错误归一化） |
| `npm run smoke` | **端到端冒烟测试**：启动真实 Electron，走完整聊天链路并断言结果 |
| `npm run package` | 只产出未打包目录 `release/win-unpacked/`（调试用，**里面的 exe 不能单独拷出来跑**） |
| `npm run dist` | 产出可分发文件并收集到 `releases/`：免安装单文件 + 安装版 |
| `npm run version:bump` | 推进版本号（日常 = 同阶段序号 +1；`--promote` 推进阶段；`--numeric` 大规模更新；`--tag` 提交后打 tag） |

### 版本号规则

规则、阶段含义与全部 `version:bump` 选项见 **[docs/versioning.md](docs/versioning.md)**。摘要：

- 预发布格式 `<major>.<minor>.<patch>-<stage><序号>`，例如 `0.1.0-alpha1`（当前版本）；
  **稳定版（LTS）就是不加后缀的裸版本**，例如 `0.1.0`
- 稳定性从低到高：`alpha` < `beta` < `rc` < **稳定版**；**推进阶段时序号归零**
  （`alpha3` → `beta0`），`rc` 再推进则后缀整体消失（`rc2` → `0.1.0`）
- **数字版本只在「大规模更新」时增加**，平时的功能与修复只动阶段内序号。
  唯一例外：稳定版已冻结，之后的任何改动必须开新的数字版本线
  （修 BUG `--numeric patch` → `0.1.1-alpha0`）
- 稳定版不带 `-ltsN` 后缀，是因为 semver 里带后缀的版本排序**低于**同号裸版本
  （`0.1.0-lts0 < 0.1.0`）—— 用裸版本表示稳定版，规则与 semver 排序才一致
- 打 tag 必须两步：`version:bump` → 提交 → `version:bump -- --tag`
  （tag 只能打给已提交的版本，否则 tag 会指向版本号还是旧值的提交）
- `package.json` 是版本号唯一真源；`tests/version-rules.spec.ts` 里有守卫用例，
  版本号写歪了 `npm test` 就会红

### 打包分发（`releases/`）

```sh
npm run dist
```

产物（Windows x64）：

| 文件 | 大小 | 说明 |
|------|------|------|
| `releases/AstraChat-<版本>-x64-portable.exe` | ≈115 MB | **免安装单文件，双击直接启动**。自解压到临时目录后运行，不写注册表、不建快捷方式。分发首选。 |
| `releases/AstraChat-<版本>-x64-setup.exe` | ≈115 MB | NSIS 安装版：可选安装目录、建开始菜单与桌面快捷方式、带卸载程序。 |

`<版本>` 就是 `package.json` 里的版本号（含阶段后缀），例如
`AstraChat-0.1.0-alpha0-x64-portable.exe`。规则见 [docs/versioning.md](docs/versioning.md)。

**⚠️ 不要从 `release/win-unpacked/` 里单独拷 `AstraChat.exe` 去分发。** 那个 exe 必须和同目录的
`resources/`、`*.dll`、`*.pak` 待在一起才能启动，单独拷出来双击只会报错。要免安装就用
`*-portable.exe`。

目录分工：`release/` 是 electron-builder 的**构建工作区**（混着 `win-unpacked/` 中间产物、
`.blockmap`、`builder-debug.yml`），`releases/` 是 `scripts/publish-releases.mjs` 收集出来的
**干净可分发目录**（每次先清空再拷贝，不会残留旧版本）。

> `releases/*.exe` 已在 `.gitignore` 里排除：单个约 115 MB，提交进 git 会永久撑大仓库历史。
> 要分发请挂到 GitHub Releases 或网盘。目录本身保留，`npm run dist` 的产物可直接双击使用。

国内网络见下方「已知坑」第 6 条（需设 `ELECTRON_BUILDER_BINARIES_MIRROR`）。
首次构建会下载 NSIS 3.0.4.1 与 nsis-resources 3.4.1，之后走缓存。

---

## 🏗️ 架构

```
astra-chat/
├── electron/                  # 主进程（Node 环境）
│   ├── main.ts                # 应用生命周期、创建窗口、初始化数据层
│   ├── ipc.ts                 # 全部 ipcMain handler 注册
│   ├── chat.ts                # 流式聊天编排（落库 + 推送事件）
│   ├── preload.ts             # contextBridge：把能力最小面暴露给渲染进程
│   └── smoke.ts               # 端到端冒烟检查（仅 ASTRA_SMOKE_LOG 时运行）
├── src/
│   ├── types/                 # 【冻结契约】领域模型 + IPC 契约 + 路由常量
│   ├── db/                    # SQLite 数据层（连接、建表、各表 CRUD、搜索、种子）
│   ├── services/              # 主进程侧服务：SSE 解析、OpenAI 兼容客户端、预设、错误
│   ├── stores/                # Zustand 状态 + 预加载桥接封装
│   ├── components/ui/         # UI 原语（Button / Field / Modal / Badge / …）
│   ├── components/chat/       # 聊天界面组件
│   ├── components/settings/   # 设置界面组件
│   ├── components/layout/     # 侧边栏外壳
│   ├── pages/                 # 页面（ChatPage / SettingsPage / PersonasPage）
│   ├── App.tsx                # 根组件（常驻侧边栏 + 页面切换 + 错误边界）
│   └── main.tsx               # 渲染进程入口
├── build/                     # electron-builder 资源目录：应用图标（icon.ico / icon.icns / icon.png）
├── scripts/                   # 构建 / 开发 / 冒烟脚本
└── tests/                     # Vitest 单元测试
```

### 进程与安全边界

渲染进程运行在**严格沙箱**下：`contextIsolation: true` + `sandbox: true` +
`nodeIntegration: false`，并且设置了 CSP、禁止自行打开新窗口与跳转外部地址。

渲染进程**没有任何 Node 权限**，一切数据访问都必须经过 `preload.ts` 用 `contextBridge`
暴露的 `window.astra`（形状即 `src/types/ipc.ts` 里的 `AstraApi`）。`ipcRenderer` 本体
绝不暴露 —— 否则往任意通道发消息的能力会让桥接形同虚设。

### 为什么流式请求跑在主进程

需求要求「用 `fetch` + `ReadableStream` 解析 SSE」。这个实现放在**主进程**
（`src/services/openai.ts`），原因有三：

1. **绕开 CORS**。渲染进程的源在生产下是 `file://`、开发下是 `http://localhost:5173`，
   直连各家的 `https://api.xxx.com` 会被同源策略拦截，而很多提供商并不返回
   `Access-Control-Allow-Origin`。
2. **API Key 不进入渲染进程**。渲染层只发 `providerId`，密钥由主进程从 SQLite 读。
3. fetch/ReadableStream 本身完全满足需求，只是发生在主进程。

数据流：

```
渲染进程 window.astra.chat.send()
  → preload contextBridge
  → ipcMain handler
  → 落库 user 消息 + 一条 status='streaming' 的 assistant 占位消息
  → 主进程 fetch + ReadableStream，增量解析 SSE
  → 节流落库正文（120ms 一次，终态必写）
  → webContents.send 推送 delta 事件
  → 渲染进程按 messageId 精确追加，完成后用 done 事件里的消息替换占位
```

### 数据库

6 张表（schema v2）：`providers`、`conversations`、`messages`、`personas`、`qq_config`、
`qq_contacts`。
时间戳统一为 Unix 毫秒；外键已开启（`PRAGMA foreign_keys = ON`），删除对话会级联
删除其消息，删除提供商/角色会把关联对话的对应外键置空。schema 版本用
`PRAGMA user_version` 记录，迁移逻辑见 `src/db/connection.ts`。

`qq_contacts`（v2 新增）承载 QQ 来源授权，见下方「已知坑」第 10 条与
[docs/qq-integration-design.md](docs/qq-integration-design.md) §5。

数据库文件位置：`<userData>/astra-chat.db`（设置页「关于」区块会显示完整路径）。

---

## 🧪 测试与验证

```sh
npm run typecheck   # 主进程 + 渲染进程类型检查
npm test            # 单元测试
npm run smoke       # 端到端冒烟（需要先 npm run build）
```

`npm run smoke` 会启动一个**假的 OpenAI 兼容 SSE 服务端**（本地随机端口，并把分片边界
刻意切在一行 JSON 与 UTF-8 多字节字符中间），然后用**隔离的临时 userData** 启动真实
Electron，完整验证：

- SQLite 建表 / schema 版本 / 内置角色种入 / QQ 配置与来源授权往返
- `window.astra` 桥接注入、React 挂载
- 聊天全链路：渲染 → IPC → fetch/SSE → 落库 → 事件回推
- 事件序列为 `start → delta… → done`，增量拼接结果与假服务端逐字节一致
- 思维链透传、终态消息与库内容一致、对话标题自动命名、搜索命中

---

## ⚠️ 已知坑与工程决定

### 1. Electron 运行时不会被 npm 自动下载（重要）

本机 npm 启用了 `allow-scripts` 白名单策略，**依赖包的 postinstall 脚本会被拦截**。
Electron 正是靠 postinstall 下载那个 200MB+ 的运行时二进制，被拦截后
`node_modules/electron/dist/` 是空的，`electron .` 直接失败，而 npm 只在日志里留一行
warn，很容易被忽略。

因此项目自带一个根级 `postinstall`（`scripts/ensure-electron.mjs`）：根项目自己的脚本
不受该策略限制，它会检查 Electron 二进制是否存在，缺失就补下载（幂等）。国内网络可先设
镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm run postinstall
```

### 2. 刻意**不**放行 better-sqlite3 的编译脚本

`.npmrc` 里 `allow-scripts=electron` 只放行了 electron，**没有**放行 better-sqlite3。
它的 install 脚本是 `node-gyp rebuild`，本机没有 MSVC 工具链，放行只会让安装失败。

而 better-sqlite3 **v13 起改用了 Node-API（node-addon-api）并把预编译产物直接打进 npm
tarball 的 `prebuilds/` 目录**，因此：

- 无需 `electron-rebuild`，无需 MSVC，无需 Python；
- **同一份二进制同时适用于 Node 与 Electron**（已实测：Node 24 ABI 与 Electron 44
  ABI 149 下均可正常读写 SQLite）。

这也正是 `npm test`（纯 Node 跑 Vitest）与 Electron 应用能共用同一份 `node_modules`
的原因。如果未来升级到不再自带 prebuilds 的版本，就需要补 `@electron/rebuild`。

### 3. 主进程用 esbuild 而不是 Vite 构建

`electron/` 下的代码必须产出真实的 CommonJS 文件（`.cjs`）才能被 Electron 与沙箱
preload 加载，Vite 的 dev server 无法服务于主进程。因此 `scripts/build-main.mjs` 用
esbuild 把 `electron/main.ts`、`electron/preload.ts` 各自打成单文件 CJS，
`electron` 与 `better-sqlite3` 保持 external（原生模块不能打包）。

`npm run dev` **不会**热重载主进程代码 —— 改了 `electron/` 或 `src/db`、`src/services`
需要重启 `npm run dev`。

### 4. 渲染层资源必须用相对路径

生产环境用 `file://` 加载 `dist/renderer/index.html`，绝对路径 `/assets/...` 会解析到
磁盘根目录导致白屏。因此 `vite.config.ts` 里设了 `base: './'`。

### 5. 流式事件用 messageId 定位，不用「最后一条消息」

`delta` 事件携带 `streamId` 与 `messageId`，渲染层必须按 `messageId` 精确追加。若图省事
往「最后一条消息」上拼，切换对话或并发流时内容就会串到别的消息里。

### 6. 打包时需要从 GitHub 下载构建工具，国内网络会超时

`npm run package` / `npm run dist` 期间，electron-builder 会去 GitHub 拉取 Electron 运行时
与 winCodeSign/NSIS 等构建工具。国内直连常见 `connect ETIMEDOUT 20.205.243.166:443`（GitHub），
表现为打包中途失败、`release/win-unpacked` 被清掉只留一个 `.tmp` 目录。

用镜像即可（本项目已实测通过）：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run package
```

> 注意这是**网络问题不是代码问题**：`npm run build`、`npm test`、`npm run smoke` 都不需要联网。

#### 附：另一个长得像但成因不同的失败 —— `win-unpacked.tmp` 改名 EPERM

打包时还可能报：

```
⨯ EPERM: operation not permitted, rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'
```

**先别急着怀疑权限**。这个和上面那条 GitHub 超时是两回事，实测结论：

- `release/` 目录**可写**，且**没有任何残留 electron / AstraChat 进程**时也会发生；
- 出错后手工 `Rename-Item release\win-unpacked.tmp win-unpacked` **会成功**。

所以它是 electron-builder 解压完 400 MB Electron 载荷后那一下 rename **被瞬时占用**
（典型是新解压目录正被杀软实时扫描），属于时序竞争而非权限或句柄泄漏。

两种走法（都实测可用）：

```powershell
# 走法 1：手工补上那一步改名，然后直接再跑一次 builder（它会跳过解压）
Rename-Item release\win-unpacked.tmp win-unpacked
npx electron-builder

# 走法 2：整个删掉重来（若 tmp 不完整）
Get-Process electron,AstraChat -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item release -Recurse -Force
npm run dist
```

> 注意走法 1 里 `npx electron-builder` 而不是 `npm run dist`：`dist` 会先重跑 `build`，
> 而这一步跟打包失败无关，没必要重来。
> 另外 electron-builder 的下载缓存不在本项目里（`ELECTRON_BUILDER_CACHE` 未生效），
> 每次打包都可能重新下载，因此建议把上面两个变量固化成用户级环境变量。

### 7. `src/stores/bridge.ts` 用 `globalThis` 而不是裸 `window`

渲染进程里 `globalThis === window`，写法上两者等价。但 `tests/**` 会 import store，而
`tsconfig.node.json` 的 `lib` 不含 DOM，裸 `window` 在那里会报 `TS2304: Cannot find name 'window'`。
用 `globalThis as unknown as { astra?: AstraApi }` 可以让同一份代码在 DOM 与非 DOM 两种
lib 环境下都通过类型检查。同理，**给 store 写单测时要把 `astra` 直接挂到 `globalThis` 上**
（而不是造一个独立的 `window` 对象），否则会与真实渲染进程的语义不一致。

### 8. 应用图标：四角必须是透明 alpha，否则深色任务栏下会露白角

`electron-builder.yml` 里 `directories.buildResources: build`，所以应用图标固定放在 `build/`：

| 文件 | 格式 | 用途 |
|------|------|------|
| `build/icon.ico` | 126 KB，**7 帧 PNG 压缩**（16/24/32/48/64/128/256） | Windows（exe 资源 / 任务栏 / 开始菜单） |
| `build/icon.icns` | 1.6 MB，**6 个 PNG 条目**（`ic11 ic12 ic07 ic13 ic14 ic10` = 32/64/128/256/512/1024） | macOS |
| `build/icon.png` | 1024×1024，**Format32bppArgb** | Linux，同时作为重新生成各尺寸的母版 |

**关键：圆角方块之外必须是真的透明（`alpha = 0`），不能是不透明白底。** Windows 的任务栏和标题栏**不会**给图标套遮罩，四角的白色会原样显示——在深色任务栏上就是四个白角缺口。生成图（GPT-image 之类）默认给的是不透明白底，必须抠掉。

抠图安全性已实测：外部白底 22043 像素（2.1%），与白色气泡**不连通**（气泡被深蓝包住），所以「从**边框种子**向内做亮度 > 150 的洪水填充」只吃外部白底、不伤主体。**必须从边框种子开始**，全图删白色会把气泡一起掏空。

ICO 用 **PNG 压缩帧**（Vista+ 支持），不必退回 BMP/DIB + AND 掩码的老格式，小尺寸也不掉色。

验证方式（不依赖任何图像库）：

```powershell
Add-Type -AssemblyName System.Drawing
$ico = [System.Drawing.Icon]::ExtractAssociatedIcon("release\win-unpacked\AstraChat.exe")
$ico.ToBitmap().Save("extracted.png")   # 肉眼确认，或与我们自己的 icon.png 逐像素比
```

> 换新图标时：抠白底 → 存 1024 RGBA 的 `build/icon.png` → 再生成多尺寸 ico / icns。
> 打包日志里不再出现 `default Electron icon is used reason=application icon is not set` 即为生效。

### 9. 界面图标一律用 `src/components/ui/icons.tsx`，**禁止用 emoji**

14 处原本用 emoji / 文字符号当图标（`💬` `🎭` `⚙️` `🔌` `ℹ️` `✨` `⚠️` `🗑` `✎` `✕` `✦` `🛰️` `💥` `↓`），现已全部替换为内联 SVG。**不要改回去**，原因不是审美：

- Windows 上 emoji 由 **Segoe UI Emoji 彩色字体**渲染，它**忽略 `currentColor`** —— hover、选中态、`--astra-accent` 靛蓝紫配色对它们全部无效，emoji 永远显示自己那套彩色。
- 同一 emoji 在 Windows / macOS / Linux 与不同 Chromium 版本下字形不同，界面跨平台不一致。
- emoji 的基线不受控，跟文字对不齐；`size` 也失去意义。
- 无法统一 `stroke-width`，做不出统一的线性图标语言。

约定：图标放 `src/components/ui/icons.tsx`，24×24 网格、`stroke-width` 1.75、`stroke="currentColor"`、`stroke-linecap/linejoin: round`；颜色一律靠外层的 `text-*` 工具类给（因此 hover 变色免费）。新增图标请一并从 `src/components/ui/index.ts` 导出。

两条相关的类型约定（都是踩过的坑）：

1. **`src/types/**` 里不能 import `.tsx`**。`tsconfig.node.json` 也包含 `src/types/**`，那份配置没有 DOM lib、也没开 `jsx`，一旦 import 组件就会连锁报错。所以 `AppNavItem.icon` 存的是字符串 key（`'chat' | 'personas' | 'settings'`），映射表放在 `AppSidebar` 里。
2. **`main.tsx` 的「桥接缺失」整页要在 React 挂载之前显示**（那种情况下根本不会 `createRoot`），所以它只能用内嵌的 SVG **字符串**，与 `IconWarning` 造型重复一份，改动其一时要同步另一处。

审计方式（应当零命中）：

```sh
# 在仓库根目录，用 ripgrep
rg '[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}\x{2726}\x{2715}\x{2713}\x{2714}]' src
```

> 12 个图标总计只增加 3.5 KB（gzip +1.14 KB），可以忽略。

### 10. schema v2：迁移用「重建表」而不是逐列加列，QQ 白名单从手填改成「发现后授权」

两件事都值得记下来，因为都不是凭直觉会做的选择。

**(1) 迁移为什么重建表。** v1 → v2 要给 `qq_config` 加 10 个新列。直觉做法是
`ALTER TABLE ADD COLUMN`，但那样新列会被追加到 `updated_at` **之后**，而「全新库」
走的是另一份 v2 DDL，`updated_at` 在最后 —— **两条路径产出的列顺序不同**。
`tests/qq-schema.spec.ts` 里有一条用例专门把两条路径分别建库再逐表比对列名与类型，
它当场就把这个分叉抓了出来。

顺序本身在按名取列时无语义，但「两条路径产出同一个结构」是更强、更好推理的不变量，
所以改成：把旧表改名 → 用与全新库**同一份 DDL 常量**建新表 → 搬数据 → 删旧表，
整个过程包在一个事务里。一致性由**构造**保证，而不是靠两份 DDL 字面量慢慢写歪。

顺带一个教训：那条用例第一次跑还失败在「`providers` 表在升级库里不存在」——
因为我的 v1 测试夹具只建了 `qq_config`。真实的 v1 库里其余 4 张表本来就在。
夹具改成「先用当前代码建库，再把 `qq_config` 退化成 v1 形态」，才既真实又不会产生假失败。

**(2) QQ 白名单为什么不能手填。** v0.1.0 让用户填「群号」（数字校验）。但官方 QQ 开放
平台只给机器人 `openid`（`group_openid` / `user_openid`），**不给 QQ 号 / 群号**，用户
根本没有地方查到这些值，手填这条路走不通。

所以 v2 新增 `qq_contacts` 表，把授权改成三态 `none` / `allow` / `deny`：
机器人收到消息时先把来源记下来（默认 `none`，此时**消息不投给模型**），
用户在设置页「已发现的来源」里逐条授权。`deny` 优先于 `allow`。
配套的默认值是 **fail-closed**：`enabled=false`、`allowAllWhenEmpty=false`。

授权操作**不做乐观更新**（先落库、成功后再改界面）：它决定消息要不要投给模型，
界面显示「已允许」而库里是 `none` 是安全边界上最危险的不一致。
`tests/qq-store.spec.ts` 有一条用例专门锁住这个行为。设计细节见
[docs/qq-integration-design.md](docs/qq-integration-design.md)。

### 11. `scripts/` 里的脚本为什么能 `import` 一个 `.ts`（附沙箱下 `stdio` 的 EPERM）

`scripts/bump-version.mjs` 里有一行 `await import('../src/services/version.ts')` —— 直接
import 了一个 TypeScript 文件。这是**故意**的：

- Node 22.18+ 默认启用「类型擦除」，可以原生 import TS。好处是版本规则的实现**只存在一份**
  （`src/services/version.ts`），脚本与单测共用，不需要编译步骤，也不必给 tsconfig 开
  `allowJs`（`scripts/**/*.mjs` 虽然写在 `include` 里，但没开 `allowJs` 时其实不参与类型检查，
  所以脚本里的逻辑**没有**类型保障 —— 把逻辑放进 TS 才是拿到保障的唯一办法）。
- 代价有两个，都在预期内：
  1. 要求 **Node ≥ 22.18**（已写进 `package.json` 的 `engines`）。脚本开头有版本守卫，
     老版本会得到明确提示而不是费解的语法报错。
  2. 被 import 的 TS 只能用**可擦除语法** —— 不能有 `enum`、`namespace`、构造函数参数属性。
     `src/services/version.ts` 满足这个约束（全是函数 + interface + type 别名）。

另外记一条本机沙箱的坑：Node 的 `child_process` 用默认 `stdio: 'pipe'` 会 `EPERM`
（受限模式下不能开命名管道），所以 `--tag` 走 `execFileSync('git', ..., { stdio: 'inherit' })`。
PowerShell 自己的管道不受影响，但 Node 捕获子进程输出会直接失败。

---

## 📌 v0.1.0 的边界（有意不做）

- **QQ bot 不建立真实连接**：只做配置存储、来源授权与状态呈现。真实连接（官方 QQ 开放
  平台 Bot API）实现于后续阶段，复用 `src/db/qq.ts` 与 `src/db/qq-contacts.ts`。
- 只支持 **OpenAI 兼容协议**；Anthropic 与 Gemini 走各自官方的 OpenAI 兼容端点。
- API Key 在 SQLite 中**明文存储**，未接系统钥匙串。
- API Key/AppSecret/Token 在界面上只做掩码展示，但未做额外的静态加密。
- 不做多模态输入、附件上传、Office 套件（明确排除在范围外）。

---

## 📄 许可证

本项目基于 **MIT** 许可证开源，见 [LICENSE](LICENSE)。
完全自研，未复制任何 AGPL 项目的代码。

设计上参考过若干开源项目的**思路**（不含代码）。需要特别说明的是
`Derpyu520/qq-bridge`：该仓库内**没有 LICENSE 文件**，其根 `package.json` 也没有
`license` 字段，按默认规则属于「保留所有权利」。因此本项目**只借鉴其设计思想、
未复制任何代码** —— 所借鉴的具体条目与自研替代方案见
[docs/qq-integration-design.md](docs/qq-integration-design.md) §4.3。若将来需要引用其代码，
须先取得作者授权并在 `ATTRIBUTION.md` 中登记。
