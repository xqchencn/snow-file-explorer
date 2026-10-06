import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranslateOptions } from '../src/types/plugin-runtime.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

/**
 * dist/plugin.json 的清单形状（本文件校验用到的字段）。
 * @description dist 是构建产物而非源码，tsc 看不到它的类型；这里按本文件逐条断言的字段收口，
 *   字段是否真的成立仍由运行期断言把关（JSON.parse 的结果一律当外部输入看待）。
 */
type DistPluginManifest = {
  /** 插件唯一 id；断言精确匹配 com.github.xqchencn.snow-file-explorer。 */
  id: string;
  /** 作者；断言等于 package.json 的 author。 */
  author: string;
  /** 渲染模式；断言为 esm（宿主据此决定模块加载方式）。 */
  renderMode: string;
  /** 版本号；构建时从 package.json 注入，断言非空且与 package.json 一致。 */
  version?: string;
  /** 许可标识；本文件只在末条用例经 any 读取，这里按可缺登记。 */
  license?: string;
  /** 面板声明；只校验是非空数组，元素结构不在本文件职责内。 */
  panels?: unknown[];
  /** 入口文件相对 dist 根的路径；必须存在且不跳出 dist。 */
  entry?: string;
  /** 样式文件相对路径清单；必须非空、逐个存在且非空文件。 */
  styles?: string[];
  /** 语言 → 语言包相对路径的映射；每个值都必须指向 dist 内的合法 JSON。 */
  locales?: Record<string, string>;
};

/** 读取 dist 里的 JSON 产物并按给定形状收口（值是否成立由用例断言把关）。 */
function readDistJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/**
 * 在 global 上安装一个宿主 DOM 全局（Element / window / document）。
 * @description lib.dom 把这几个全局声明为必然存在且类型固定，Node 里只能用 mock 顶替，
 *   而 mock 的形状永远满足不了真实 DOM 类型；defineProperty 与直接赋值等价
 *   （同为 configurable/writable/enumerable 的自有数据属性），只是绕开了赋值类型检查。
 */
function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
}


test('分发包完整性: dist 目录存在且包含所有直接安装运行所需文件', () => {
  assert.ok(fs.existsSync(distDir), 'dist 目录必须存在');
  assert.ok(fs.existsSync(path.join(distDir, 'plugin.json')), 'dist/plugin.json 必须存在');

  const jsPath = path.join(distDir, 'index.js');
  assert.ok(fs.existsSync(jsPath), 'dist/index.js 必须存在');
  const jsStat = fs.statSync(jsPath);
  assert.ok(jsStat.size > 40 * 1024, `dist/index.js 体积需合理 (>40KB)，当前: ${(jsStat.size / 1024).toFixed(1)}KB`);
  assert.ok(jsStat.size < 400 * 1024, `dist/index.js 不应再包含高亮、图标和终端（<400KB），当前: ${(jsStat.size / 1024).toFixed(1)}KB`);

  for (const chunk of ['icons.js', 'highlighter.js', 'terminal.js', 'markdown.js']) {
    const chunkPath = path.join(distDir, 'chunks', chunk);
    assert.ok(fs.existsSync(chunkPath), `dist/chunks/${chunk} 必须存在`);
    assert.ok(fs.statSync(chunkPath).size > 1024, `dist/chunks/${chunk} 不得为空`);
  }

  const cssPath = path.join(distDir, 'index.css');
  assert.ok(fs.existsSync(cssPath), 'dist/index.css 必须存在');
  const cssStat = fs.statSync(cssPath);
  assert.ok(cssStat.size > 5 * 1024, `dist/index.css 体积需合理 (>5KB)，当前: ${(cssStat.size / 1024).toFixed(1)}KB`);

  // 终端与高亮的样式随各自块走（首屏不背），块加载时由 lazy-chunk 注入。
  for (const chunkCss of ['terminal.css', 'highlighter.css']) {
    const cssChunkPath = path.join(distDir, 'chunks', chunkCss);
    assert.ok(fs.existsSync(cssChunkPath), `dist/chunks/${chunkCss} 必须存在`);
    assert.ok(fs.statSync(cssChunkPath).size > 512, `dist/chunks/${chunkCss} 不得为空`);
  }

  const localesDir = path.join(distDir, 'locales');
  assert.ok(fs.existsSync(localesDir), 'dist/locales/ 必须存在');
  assert.ok(fs.existsSync(path.join(localesDir, 'zh-CN.json')), 'dist/locales/zh-CN.json 必须存在');
  assert.ok(fs.existsSync(path.join(localesDir, 'zh-TW.json')), 'dist/locales/zh-TW.json 必须存在');
  assert.ok(fs.existsSync(path.join(localesDir, 'en.json')), 'dist/locales/en.json 必须存在');
});

test('独立可安装清单自包含性: dist/plugin.json 引用所有文件均自闭环且存在', () => {
  const manifestPath = path.join(distDir, 'plugin.json');
  const manifest = readDistJson<DistPluginManifest>(manifestPath);

  // 1. 基础元数据校验
  assert.equal(manifest.id, 'com.github.xqchencn.snow-file-explorer', '插件 ID 必须精确匹配');
  assert.equal(manifest.author, 'xqchen', '作者必须为 xqchen');
  assert.equal(manifest.renderMode, 'esm', '渲染模式必须为 esm');
  assert.ok(manifest.version, '版本号必须存在');
  assert.ok(Array.isArray(manifest.panels) && manifest.panels.length > 0, '必须配置有效的 panels 列表');

  // 2. 入口文件自闭环校验 (dist 内部存在且为相对路径)
  assert.ok(manifest.entry, 'entry 必须声明');
  assert.ok(!path.isAbsolute(manifest.entry), 'entry 必须是相对路径');
  assert.ok(!manifest.entry.startsWith('..'), 'entry 不得跳出 dist 目录');
  assert.ok(fs.existsSync(path.join(distDir, manifest.entry)), `entry 指向的文件 ${manifest.entry} 在 dist 中必须存在`);

  // 3. 样式文件自闭环校验
  assert.ok(Array.isArray(manifest.styles) && manifest.styles.length > 0, 'styles 必须声明非空数组');
  // 上面的复合断言给不了 tsc 窄化信息，这里按同一事实（styles 必有）再断一次，好让下面的遍历通过检查。
  assert.ok(manifest.styles);
  for (const styleFile of manifest.styles) {
    assert.ok(!path.isAbsolute(styleFile), `style ${styleFile} 必须是相对路径`);
    assert.ok(!styleFile.startsWith('..'), `style ${styleFile} 不得跳出 dist 目录`);
    const fullStylePath = path.join(distDir, styleFile);
    assert.ok(fs.existsSync(fullStylePath), `style 指向的文件 ${styleFile} 在 dist 中必须存在`);
    assert.ok(fs.statSync(fullStylePath).size > 0, `style 文件 ${styleFile} 不得为空`);
  }

  // 4. 多语言包自闭环校验
  assert.ok(manifest.locales && typeof manifest.locales === 'object', 'locales 必须声明映射字典');
  // 同上：复合断言不产生窄化，遍历前再断一次 locales 必有。
  assert.ok(manifest.locales);
  for (const [lang, localeFile] of Object.entries(manifest.locales)) {
    assert.ok(!path.isAbsolute(localeFile), `locale ${lang} 路径必须是相对路径`);
    assert.ok(!localeFile.startsWith('..'), `locale ${lang} 不得跳出 dist 目录`);
    const fullLocalePath = path.join(distDir, localeFile);
    assert.ok(fs.existsSync(fullLocalePath), `语言包 ${localeFile} 在 dist 中必须存在`);
    const content = fs.readFileSync(fullLocalePath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(content), `语言包 ${localeFile} 必须是合法的 JSON 格式`);
  }
});

test('自包含约束: dist/index.js 无相对 import 且 dist/index.css 无 @import', () => {
  const jsContent = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8');
  const relativeImports = jsContent.match(/import\s*.*?from\s*['"]\.\.?\/[^'"]+['"]/g) || [];
  assert.equal(relativeImports.length, 0, `dist/index.js 发现非法的相对 import: ${relativeImports.join(', ')}`);
  assert.equal(jsContent.includes('prismjs'), false, '入口不应包含 Prism');
  assert.equal(jsContent.includes('@xterm'), false, '入口不应包含 xterm');
  assert.equal(jsContent.includes('DOMPurify'), false, '入口不应包含 DOMPurify');
  for (const chunk of ['icons.js', 'highlighter.js', 'terminal.js', 'markdown.js']) {
    const chunkSource = fs.readFileSync(path.join(distDir, 'chunks', chunk), 'utf8');
    const chunkImports = chunkSource.match(/import\s*.*?from\s*['"]\.\.?\/[^'"]+['"]/g) || [];
    assert.equal(chunkImports.length, 0, `chunks/${chunk} 发现非法的相对 import: ${chunkImports.join(', ')}`);
  }

  const cssContent = fs.readFileSync(path.join(distDir, 'index.css'), 'utf8');
  const cssImports = cssContent.match(/@import\s+[^;]+;/g) || [];
  assert.equal(cssImports.length, 0, `dist/index.css 样式发现未内联的 @import: ${cssImports.join(', ')}`);
});

test('宿主加载模拟: 通过 Data URI (Blob URL 等效) 动态 import 并挂载', async () => {
  const jsContent = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8');

  // 模拟宿主 DOM 全局环境
  if (!global.Element) {
    defineGlobal(
      'Element',
      class MockElement {
        matches(): boolean {
          return false;
        }
      }
    );
  }

  const createMockElement = (tag: string) => {
    const node = Object.create(global.Element.prototype);
    node.tagName = String(tag || '').toUpperCase();
    node.className = '';
    node.style = {};
    node.children = [];
    node.appendChild = (child: unknown) => node.children.push(child);
    node.removeChild = (child: unknown) => {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
    };
    node.replaceChildren = () => {
      node.children = [];
    };
    node.setAttribute = () => {};
    node.getAttribute = () => null;
    // 文件图标与工具窗口停靠都写在 dataset 上（iconName / toolDock）。
    node.dataset = {};
    node.addEventListener = () => {};
    // 插件在同步栏等组件里使用 classList（标准 DOM API），mock 必须建模，
    // 否则挂载路径会抛 "Cannot read properties of undefined (reading 'add')"。
    const classes = new Set<string>();
    node.classList = {
      add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    };
    // 补齐真实 DOM 查询契约（插件会在重建前读取文件树滚动容器）
    node.querySelector = () => null;
    node.querySelectorAll = () => [];
    return node;
  };

  defineGlobal('window', global);
  defineGlobal('document', {
    createElement: createMockElement,
    createElementNS: (_ns: string | null, tag: string) => createMockElement(tag),
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  });

  const dataUri = 'data:text/javascript;base64,' + Buffer.from(jsContent).toString('base64');
  const mod = await import(dataUri);

  assert.ok(mod, '模块导入成功');
  assert.equal(typeof mod.mount, 'function', '导出的 mount 必须是函数');
  assert.ok(mod.default, '必须导出 default');
  assert.equal(typeof mod.default.mount, 'function', 'default.mount 必须是函数');

  const container = global.document.createElement('div');
  // api 走 data URI 动态 import，mod 是 untyped 的（宿主类型不在 dist 里），
  // 这里只按插件实际调用的 t / metadata.get 两个成员标注形状。
  const api = {
    t: (key: string, opts?: TranslateOptions) => (opts && opts.defaultValue) || key,
    metadata: {
      get: async () => ({ path: 'D:/test' }),
    },
  };

  const unmount = mod.mount(container, api);
  assert.equal(typeof unmount, 'function', 'mount 必须返回 unmount 清理函数');
  assert.ok(container.children.length > 0, '挂载后 container 必须包含子节点');

  // 验证卸载清理
  unmount();
  assert.equal(container.children.length, 0, 'unmount 执行后必须清空 container');
});

test('工程清洁度: 根目录无冗余打包产物残留', () => {
  const redundantFiles = ['index.js', 'index.css', 'style.css', 'styles'];
  for (const item of redundantFiles) {
    const p = path.join(rootDir, item);
    assert.equal(fs.existsSync(p), false, `根目录不应存在构建产物或废弃文件: ${item}`);
  }
});

test('单一维护源契约: dist/plugin.json 版本/作者/许可取自 package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'plugin.json'), 'utf8'));
  // 版本号只在 package.json 维护一处，构建时注入清单，避免升级版本时两处漂移
  assert.equal(manifest.version, pkg.version, 'dist/plugin.json 的 version 必须等于 package.json 的 version');
  assert.equal(manifest.author, pkg.author, 'dist/plugin.json 的 author 必须等于 package.json 的 author');
  assert.equal(manifest.license, pkg.license, 'dist/plugin.json 的 license 必须等于 package.json 的 license');
});

