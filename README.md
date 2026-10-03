# Snow App 文件浏览器插件 (File Explorer Plugin)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Format: ESM](https://img.shields.io/badge/Module-ESM-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![Build Tool: esbuild](https://img.shields.io/badge/Bundler-esbuild-orange.svg)](https://esbuild.github.io/)
[![Linter: ESLint](https://img.shields.io/badge/Linter-ESLint_9-4B32C3.svg)](https://eslint.org/)

专为 [Snow App](https://github.com/MayDay-wpf/snow-app) 打造的原生桌面级侧边栏文件浏览扩展。提供深度的项目文件树导航、彩色文件图标库、实时 Git 状态色彩追踪、全语言语法高亮代码查看器、图片即时预览及多语言国际化支持。

---

## 🌟 核心特性 (Key Features)

- **现代化工业级打包与物理隔离架构**:
  - 开发源码（`src/`）与生产分发包（`dist/`）彻底分离。
  - 基于 `esbuild` 实现 AST 分析、Tree Shaking 与自包含 ESM 单文件打包与深度压缩。
  - **发布物完全自包含与可独立安装**：`dist/` 目录内直接完备打包包含 `plugin.json`、自包含 `index.js`、合并内联 `index.css` 及完整 `locales/`，无任何未解析的外部或相对模块说明符，可直接被宿主即时安装加载。
- **Git 变更状态全周期追踪**:
  - 自动适配 `window.snow.gitStatus` 与 `window.snow.onGitStatusChanged`。
  - 目录树中实时渲染文件改动徽章（`M` 已修改、`U` 未跟踪、`A` 新增、`D` 已删除、`R` 重命名）并跟随宿主色彩规范高亮条目名称。
- **彩色文件图标体系**:
  - 采用 `material-icon-theme`（VSCode 官方文件图标主题）彩色 SVG 图标：按需裁剪 588 个彩色图标，1381 条扩展名映射 + 2148 条特殊文件名映射（如 `package.json`、`Dockerfile`、`.gitignore`）。按文件名 → 扩展名逐级匹配，末级回退通用文件/文件夹图标。**全程零手写 SVG**。
- **全语言语法高亮引擎**:
  - 覆盖 Prism 全部 **297 种语言**词法分析（核心 4 种内置 + 293 种按依赖拓扑序注册），443 条扩展名/别名映射。
  - 高亮样式经真实多语言样本实测覆盖 **112 个 Prism token 类别**（`title`/`key`/`selector`/`parameter`/`bold`/`italic`/`arrow`/`unit` 等全数着色），杜绝"分词了却没颜色"。
  - 独创超大文件（> 250,000 字符）极速熔断通道，避免卡死宿主界面并全面防御 XSS 注入。
  - 纯粹继承宿主 `ThemePalette` CSS 变量（`--accent-color`, `--bg-primary`, `--text-primary` 等），全生命周期跟随宿主明暗/自选主题无缝响应。
- **代码视窗与多媒体预览**:
  - 自动生成行号栏，右上方提供悬浮式一键复制按钮与即时状态反馈。
  - 支持常见的图片格式（PNG, JPG, SVG, WebP, GIF, ICO, AVIF）无损原样渲染。
- **Markdown 文档预览**:
  - `.md` / `.markdown` / `.mdx` / `.mkd` 默认进入富文本预览模式，可在「预览 / 代码」之间一键切换。
  - 基于 `marked` 解析 + `DOMPurify` 白名单净化，剥离脚本、`on*` 事件属性与危险标签，防御 Markdown 注入型 XSS。
  - 文档内相对路径图片经宿主文件接口读取为内联 data URL 展示（进程内缓存，重复渲染零重复 IO）。
- **国际化 (i18n) 完整覆盖**:
  - 原生内置简体中文（`zh-CN`）、繁体中文（`zh-TW`）与英文（`en`）。

---

## 📁 目录规范 (Architecture & Structure)

```
file-explorer/
├── package.json              # npm 工程依赖与脚本定义
├── eslint.config.js          # ESLint 9 Flat Config 静态规范检测
├── build.js                  # 工业级 esbuild 打包脚本 (产物完全交付至 dist/)
├── tools/
│   └── generate.mjs          # 代码生成器：从 prismjs / material-icon-theme 权威数据产出生成文件
├── plugin.json               # 根目录清单模板（版本/作者/许可由 package.json 注入，单一维护源）
├── locales/                  # 国际化源多语言包 (zh-CN, zh-TW, en)
├── tests/                    # Node.js 22 内置测试器自动化测试套件（目录结构镜像 src/）
│   ├── bundle.test.js        # dist/ 独立完整性、清单闭环与宿主加载契约集成测试
│   └── src/
│       ├── components/       # 与 src/components/ 一一对应
│       │   ├── highlighter.test.js
│       │   ├── markdown-renderer.test.js
│       │   ├── code-viewer.test.js
│       │   └── git-view.test.js
│       ├── services/         # 与 src/services/ 一一对应
│       │   ├── file-service.test.js
│       │   ├── markdown-asset.test.js
│       │   ├── file-filter.test.js
│       │   ├── diff.test.js
│       │   └── git-service.test.js
│       └── utils/
│           └── dom.test.js
├── src/                      # 纯净开发源码目录 (与产物物理隔离)
│   ├── index.js              # 插件挂载入口源码 (生命周期与组件编排)
│   ├── index.css             # 样式聚合入口源码 (@import 模块化样式)
│   ├── components/
│   │   ├── tree-view.js      # 目录树组件 (递归展开、Git 状态与条目计数)
│   │   ├── code-viewer.js    # 代码查看器 (行号栏、复制、图片展示、Markdown 预览/代码切换)
│   │   ├── diff-view.js      # 轻量 unified diff 渲染 (统一/分栏双模式)
│   │   ├── git-view.js       # Git 变更面板 (提交框 + 已暂存/变更分区列表)
│   │   ├── markdown-renderer.js # Markdown 渲染 (marked 解析 + DOMPurify 净化)
│   │   ├── highlighter.js    # 基于 PrismJS 封装的高性能高亮器
│   │   └── prism-langs.js    # 【生成文件】Prism 297 语言注册与扩展名映射
│   ├── services/
│   │   ├── file-service.js   # window.snow 文件系统接口适配与排序
│   │   ├── file-filter.js    # 元数据排除与 .gitignore 解析/匹配
│   │   ├── markdown-asset.js # Markdown 识别、相对图片路径解析与本地图片读取
│   │   ├── diff.js           # unified diff 解析纯函数 (hunk/行号/分栏配对)
│   │   ├── git-service.js    # window.snow Git 状态与事件订阅适配
│   │   ├── git-actions.js    # Git 写操作 (暂存/提交/推送/丢弃/AI 生成)
│   │   └── settings.js       # 视图开关与偏好持久化 (api.storage)
│   ├── icons/
│   │   ├── action-icons.js   # 基于 lucide 标准库的界面交互图标
│   │   ├── file-icons.js     # 文件图标解析 (文件名/扩展名 → 彩色 SVG)
│   │   └── icon-data.js      # 【生成文件】Material Icon Theme 彩色图标 (588 个)
│   ├── utils/
│   │   └── dom.js            # el 元素构造、humanSize、escapeHtml、剪贴板
│   └── styles/
│       ├── base.css          # Snow App 调色板 CSS 变量纯净绑定
│       ├── tree.css          # 文件树条目、Git 状态色彩与徽章样式
│       ├── viewer.css        # 代码查看器行号与浮动按钮布局
│       ├── diff.css          # unified/split diff 渲染样式
│       ├── git-view.css      # Git 变更面板与提交框样式
│       ├── menu.css          # 工具栏下拉菜单与开关样式
│       ├── markdown.css      # Markdown 预览排版与模式切换控件样式
│       └── syntax.css        # Prism Token 映射宿主主题调色体系
└── dist/                     # 【独立分发包】完全自包含、可直接安装的完整插件
    ├── plugin.json           # 由 build.js 生成（版本/作者/许可取自 package.json）
    ├── index.js              # 自包含压缩 ESM 运行时入口 (~1265 KB，含 Prism 297 语言 + Material Icons + Lucide)
    ├── index.css             # 深度合并压缩后的独立样式文件 (~29 KB)
    └── locales/              # 随包完整多语言资源
        ├── en.json
        ├── zh-CN.json
        └── zh-TW.json
```

---

## 🛠️ 本地开发与指令 (Development & Commands)

本工程采用现代专业 npm 工具链驱动：

```powershell
# 1. 切换至插件工程目录（位于本仓库的 file-explorer/ 子目录）
cd file-explorer

# 2. 生成代码（升级 prismjs / material-icon-theme 依赖后重新生成生成文件）
npm run generate

# 3. 静态代码规范检查 (ESLint)
npm run lint

# 4. 运行自动化测试套件 (包含 dist/ 独立可安装包完整性校验)
#    测试文件目录结构镜像 src/，例如 src/services/diff.js → tests/src/services/diff.test.js
#    `node --test` 会自动递归发现 tests/ 下所有 *.test.js，无需额外配置
npm test

# 5. 执行生产打包压缩 (输出全部发布内容至 dist/)
npm run build
```

---

## 🚀 插件安装与分发 (Installation Guide)

### 方法一：通过 Snow App 内置 MCP 工具 `config-set` 部署（推荐开发者使用）

在 Snow App 聊天或控制台直接调用 `config-set` 工具，将 `dist/` 目录绑定为插件源：

```json
{
  "scope": "plugins",
  "key": "com.github.xqchencn.snow-file-explorer",
  "value": {
    "sourceDir": "<本仓库 file-explorer/dist 的绝对路径>"
  }
}
```

宿主后端会自动验证 `dist/plugin.json`，并将完整的插件分发物复制安装至系统目录：
`~/.snowapp/plugins/com.github.xqchencn.snow-file-explorer`。

### 方法二：手动安装分发包

1. 执行 `npm run build` 生成 `dist/`。
2. 将 `dist/` 文件夹复制并重命名为 `com.github.xqchencn.snow-file-explorer`。
3. 放置于宿主插件目录中：
   - Windows: `C:\Users\<用户名>\.snowapp\plugins\com.github.xqchencn.snow-file-explorer`
   - macOS / Linux: `~/.snowapp/plugins/com.github.xqchencn.snow-file-explorer`
4. 重启或刷新 Snow App 即可在侧边栏启用“文件浏览器”。

---

## 📄 宿主约束与开发规范 (Host Constraints)

1. **Blob URL ESM 导入约束**:
   - 宿主 Electron 渲染进程通过 `new Blob([source], { type: "text/javascript" })` 创建 `blob:` URL 并使用动态 `import()` 加载插件入口。
   - `blob:` URL 非分层协议 scheme，Chromium 无法在运行时解析相对路径说明符（如 `import './foo.js'`）。
   - **因此，dist/index.js 必须通过 esbuild 打包成单文件自包含 ESM，严禁包含相对 import。**
2. **样式注入约束**:
   - 宿主通过 `injectPluginStyles` 将样式文本直接挂载入 `<style>` 标签，`<style>` 标签无法解析 CSS 相对 `@import`。
   - **因此，dist/index.css 必须在构建阶段由 esbuild 自动合并所有样式模块并深度压缩。**
3. **源码修改纪律**:
   - 开发与维护修改严格在 `src/` 和 `locales/` 下进行，严禁直接手改 `dist/`。

---

## 📜 许可证 (License)

[MIT License](LICENSE) © 2026 xqchen

