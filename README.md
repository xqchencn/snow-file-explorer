# Snow App 文件浏览器

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/xqchencn/snow-file-explorer?display_name=tag)](https://github.com/xqchencn/snow-file-explorer/releases)

Snow App 的本地项目文件浏览器插件。它跟随 Snow App 当前打开的项目，提供文件树、代码与图片预览、Markdown 预览、Git 变更管理、交互式终端和项目命令运行。

## 适用版本

- 需要已安装并支持插件的 [Snow App](https://github.com/MayDay-wpf/snow-app)。
- 插件操作的是 Snow App 当前激活项目目录，不在插件内单独选择项目。
- Git 功能需要当前项目是 Git 仓库，并且本机已正确配置 Git；提交和推送仍遵循仓库自身的权限与远端配置。

## 安装

### 推荐：安装 GitHub Release

1. 打开本项目的 [Releases](https://github.com/xqchencn/snow-file-explorer/releases) 页面，下载最新版本的 `snow-file-explorer-vX.Y.Z.zip`。
2. 将压缩包内容解压到下面的插件目录，并确保 `plugin.json` 直接位于插件目录根部：

   **Windows**

   ```text
   %USERPROFILE%\\.snowapp\\plugins\\com.github.xqchencn.snow-file-explorer
   ```

   **macOS / Linux**

   ```text
   ~/.snowapp/plugins/com.github.xqchencn.snow-file-explorer
   ```

3. 完全重启 Snow App，或在宿主的插件管理界面重新加载插件。
4. 在 Snow App 侧边栏打开“文件浏览器”。

解压完成后的目录结构应类似下面这样：

```text
com.github.xqchencn.snow-file-explorer/
├── plugin.json
├── index.js
├── index.css
└── locales/
    ├── en.json
    ├── zh-CN.json
    └── zh-TW.json
```

> 不要把整个 `dist` 文件夹再套一层放进去。`plugin.json` 如果位于 `...\\snow-file-explorer\\dist\\plugin.json`，宿主将无法按预期加载插件。

### 开发者：从本地构建安装

适合需要试用未发布代码的情况：

```powershell
npm install
npm run build
```

然后在 Snow App 中通过插件管理能力安装本仓库的 `dist` 目录。使用 `config-set` 时，参数如下：

```json
{
  "scope": "plugins",
  "key": "com.github.xqchencn.snow-file-explorer",
  "value": {
    "sourceDir": "D:/path/to/snow-file-explorer/dist"
  }
}
```

将 `sourceDir` 换成你本机 `dist` 的绝对路径。宿主会校验 `dist/plugin.json`，并复制完整插件包到自己的插件目录。

## 快速上手

1. 在 Snow App 中打开一个项目。
2. 打开侧边栏的“文件浏览器”。插件会自动加载当前项目根目录。
3. 左侧入口栏上方在“文件”和“Git 变更”之间切换；下方可打开“运行”和“终端”。
4. 在文件树中点击文件查看内容；点击文件夹展开或收起。
5. 单击 Git 变更文件查看差异，使用右侧查看器在完整文件、统一差异和分栏差异之间阅读变更。

## 功能说明

### 文件树

- 按文件名显示彩色文件图标，并按目录层级浏览项目。
- 右键文件或文件夹可执行：打开、复制路径、复制相对路径、在资源管理器中打开、重命名和删除。
- 右键文件树空白区域可以刷新视图，以及切换以下视图选项：
  - **按 `.gitignore` 过滤**：默认开启，隐藏 Git 忽略规则匹配的条目。
  - **Java 包结构视图**：默认开启；识别到 Java 项目时，将连续的包目录折叠成更易读的结构。
- 文件树会显示 Git 状态标记，例如已修改、未跟踪、新增、删除和重命名。

### 文件预览与编辑

- 支持代码文本预览、自动行号和语法高亮。
- 支持 PNG、JPG、SVG、WebP、GIF、ICO、AVIF 等常见图片预览。
- `.md`、`.markdown`、`.mdx` 和 `.mkd` 默认使用 Markdown 预览，可在“预览”和“代码”之间切换。
- Markdown 中的相对路径图片会从当前项目读取并显示。
- 宿主提供写入能力时，可以通过编辑、保存按钮修改文本文件；如果宿主只提供读取能力，界面会显示为只读。
- 代码查看器中的“复制”只复制当前文件内容；文件树右键菜单中的“复制”则用于复制路径或条目操作，请按菜单文字区分。

### Git 变更

切换到“Git 变更”后，可以：

- 查看已暂存和未暂存的文件变更。
- 点击文件查看差异，支持统一视图和分栏视图。
- 单个文件或整个目录暂存、取消暂存。
- 在提交框输入提交信息，点击“提交”或“提交并推送”。
- 使用“AI 生成提交信息”生成提交说明；生成过程中可以停止。
- 丢弃文件更改。

“丢弃更改”不可撤销。提交、推送和同步的具体结果取决于本地 Git 状态、远端地址、认证方式以及网络连接。

顶部同步指示器用于查看本地与远端是否存在待推送或待拉取的提交。它不是 Git 仓库初始化工具；当前目录不是 Git 仓库时，面板会直接显示相应提示。

### 运行与终端

插件将两个工具窗口分开：

- **运行**：从项目配置中识别可运行命令。通过运行工具栏或 `package.json` 脚本行内的运行按钮启动一次性任务；运行窗口显示输出、退出码，并可停止当前命令。
- **终端**：打开真正可交互的终端，可以在光标处输入命令并连续操作；支持多个终端标签页。

运行命令会使用 Snow App 的终端设置和当前项目目录。项目没有可识别的入口或宿主没有终端能力时，运行入口会提示原因，而不是猜测命令。

运行工具栏常用操作：重新运行、停止当前命令、滚动到底部、清空输出。终端标签页支持新建、关闭，以及右键关闭其他标签页或全部标签页。

#### Node.js、TypeScript 与前端框架

运行入口不按框架名称写死规则，而是读取每个 `package.json` 的 `scripts`。因此 React、Vue、Vite、Next.js、Angular、Svelte 等项目只要正确提供 `dev`、`build`、`test` 等脚本，就会以同一套方式出现。

包管理器按下面顺序识别：

1. `package.json` 的 `packageManager`，例如 `"pnpm@9.0.0"`；
2. 当前包目录的锁文件：`pnpm-lock.yaml`、`yarn.lock`、`bun.lock`/`bun.lockb`、`package-lock.json`；
3. 没有证据时回退到 npm。

生成的命令是对应包管理器的 `<manager> run <script>`。多包项目会把运行工作目录切换到对应 `package.json` 所在目录，不依赖 `npm --prefix`，所以 Yarn、pnpm、Bun 的 scripts 不会被强行改写成 npm 语法。

workspace 子包默认继承根包的包管理器；子包自身声明的 `packageManager` 或锁文件可以覆盖继承值。包管理器命令本身必须安装在系统 PATH 中，或通过项目约定的 Corepack shim 提供；插件不会偷偷下载包管理器。

TypeScript 和框架源码可以正常浏览、识别和运行其 `scripts`。插件不会自行编译 `.ts`、解析 JSX，也不会凭文件扩展名猜测启动命令；请在 `package.json.scripts` 中明确配置 `tsc`、`tsx`、Vite、Next 等实际命令。没有 `scripts` 时，仅工作区根目录支持 `index.js`、`main.js`、`app.js`、`server.js` 的 `node <entry>` 兜底，TypeScript 入口必须显式配置脚本。

### 国际化

插件内置简体中文、繁体中文和英文。显示语言跟随 Snow App 宿主设置。

## 权限与数据边界

插件清单声明了 `filesystem` 和 `terminal` 两类能力：

- `filesystem`：读取当前项目，且仅在用户明确执行打开、保存、重命名、删除等操作时进行相应文件操作。
- `terminal`：仅在用户启动运行命令或终端会话后启动进程，并读取输出和退出状态。

插件不上传项目文件，也不在插件内保存项目副本。Git 提交、推送以及 AI 提交信息生成是否可用，仍受 Snow App 宿主能力、Git 配置和网络环境影响。

## 常见问题

### 安装后侧边栏没有“文件浏览器”

检查插件目录名称是否为 `com.github.xqchencn.snow-file-explorer`，并确认 `plugin.json`、`index.js`、`index.css` 位于该目录根部。之后完全重启 Snow App。

### 显示“未检测到当前项目目录”

插件跟随宿主的当前激活项目。请先在 Snow App 中打开或切换到一个项目，再刷新文件浏览器面板。

### Git 面板显示“当前目录不是 Git 仓库”

确认当前项目根目录或其上级目录包含 `.git`，并在外部终端执行 `git status` 验证仓库本身可用。插件不会替你初始化仓库。

### 文件可以看但不能保存

这是宿主文件写入能力的限制，不是预览失败。确认 Snow App 当前版本允许插件使用文件写入，并检查插件权限或宿主日志。

### 运行按钮没有可用命令

运行入口来自项目中可识别的配置和入口文件。先确认项目配置存在、文件已保存，并检查宿主是否提供终端能力；需要持续交互时请使用“终端”窗口。

### Release 下载的压缩包无法安装

重新检查压缩包内层级：解压后应直接看到 `plugin.json`。不要把 GitHub 源码压缩包当作插件安装包，也不要把 `dist` 目录作为额外的中间层。

## 从 tag 发布新版本（维护者）

GitHub Actions 会在推送符合 `v*.*.*` 的 tag 时自动发布。发布前只改 `package.json` 的版本号，例如：

```powershell
# package.json version 为 1.0.4 时
 git tag v1.0.4
 git push origin v1.0.4
```

工作流会依次执行依赖安装、ESLint、生产构建和测试，然后：

1. 将 `dist` 内容打成 `snow-file-explorer-v1.0.4.zip`；
2. 生成同名 `.sha256` 校验文件；
3. 创建或更新对应的 GitHub Release，并上传两个文件。

tag 去掉开头的 `v` 后必须与 `package.json.version` 完全一致，否则工作流会在构建前失败。仓库的 Actions 需要允许 `contents: write`，工作流已声明所需权限，不需要额外的发布密钥。

## 本地开发命令

```powershell
npm install       # 安装依赖
npm run lint      # 检查源码
npm run build     # 生成 dist 独立安装包
npm test          # 运行测试（需要先生成 dist）
```

源码修改应放在 `src/` 和 `locales/`，不要直接编辑 `dist/`。`dist/` 是构建产物，下一次 `npm run build` 会完整重建它。

## 许可证

本项目采用 [MIT License](LICENSE)。
