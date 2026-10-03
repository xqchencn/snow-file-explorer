import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

test('分发包完整性: dist 目录存在且包含所有直接安装运行所需文件', () => {
  assert.ok(fs.existsSync(distDir), 'dist 目录必须存在');
  assert.ok(fs.existsSync(path.join(distDir, 'plugin.json')), 'dist/plugin.json 必须存在');

  const jsPath = path.join(distDir, 'index.js');
  assert.ok(fs.existsSync(jsPath), 'dist/index.js 必须存在');
  const jsStat = fs.statSync(jsPath);
  assert.ok(jsStat.size > 50 * 1024, `dist/index.js 体积需合理 (>50KB)，当前: ${(jsStat.size / 1024).toFixed(1)}KB`);

  const cssPath = path.join(distDir, 'index.css');
  assert.ok(fs.existsSync(cssPath), 'dist/index.css 必须存在');
  const cssStat = fs.statSync(cssPath);
  assert.ok(cssStat.size > 5 * 1024, `dist/index.css 体积需合理 (>5KB)，当前: ${(cssStat.size / 1024).toFixed(1)}KB`);

  const localesDir = path.join(distDir, 'locales');
  assert.ok(fs.existsSync(localesDir), 'dist/locales/ 必须存在');
  assert.ok(fs.existsSync(path.join(localesDir, 'zh-CN.json')), 'dist/locales/zh-CN.json 必须存在');
  assert.ok(fs.existsSync(path.join(localesDir, 'zh-TW.json')), 'dist/locales/zh-TW.json 必须存在');
  assert.ok(fs.existsSync(path.join(localesDir, 'en.json')), 'dist/locales/en.json 必须存在');
});

test('独立可安装清单自包含性: dist/plugin.json 引用所有文件均自闭环且存在', () => {
  const manifestPath = path.join(distDir, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

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
  for (const styleFile of manifest.styles) {
    assert.ok(!path.isAbsolute(styleFile), `style ${styleFile} 必须是相对路径`);
    assert.ok(!styleFile.startsWith('..'), `style ${styleFile} 不得跳出 dist 目录`);
    const fullStylePath = path.join(distDir, styleFile);
    assert.ok(fs.existsSync(fullStylePath), `style 指向的文件 ${styleFile} 在 dist 中必须存在`);
    assert.ok(fs.statSync(fullStylePath).size > 0, `style 文件 ${styleFile} 不得为空`);
  }

  // 4. 多语言包自闭环校验
  assert.ok(manifest.locales && typeof manifest.locales === 'object', 'locales 必须声明映射字典');
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

  const cssContent = fs.readFileSync(path.join(distDir, 'index.css'), 'utf8');
  const cssImports = cssContent.match(/@import\s+[^;]+;/g) || [];
  assert.equal(cssImports.length, 0, `dist/index.css 样式发现未内联的 @import: ${cssImports.join(', ')}`);
});

test('宿主加载模拟: 通过 Data URI (Blob URL 等效) 动态 import 并挂载', async () => {
  const jsContent = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8');

  // 模拟宿主 DOM 全局环境
  if (!global.Element) {
    global.Element = class Element {
      matches() {
        return false;
      }
    };
  }

  const createMockElement = (tag) => {
    const node = Object.create(global.Element.prototype);
    node.tagName = String(tag || '').toUpperCase();
    node.className = '';
    node.style = {};
    node.children = [];
    node.appendChild = (child) => node.children.push(child);
    node.removeChild = (child) => {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
    };
    node.replaceChildren = () => {
      node.children = [];
    };
    node.setAttribute = () => {};
    node.getAttribute = () => null;
    node.addEventListener = () => {};
    // 插件在同步栏等组件里使用 classList（标准 DOM API），mock 必须建模，
    // 否则挂载路径会抛 "Cannot read properties of undefined (reading 'add')"。
    const classes = new Set();
    node.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
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

  global.window = global;
  global.document = {
    createElement: createMockElement,
    createElementNS: (_ns, tag) => createMockElement(tag),
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const dataUri = 'data:text/javascript;base64,' + Buffer.from(jsContent).toString('base64');
  const mod = await import(dataUri);

  assert.ok(mod, '模块导入成功');
  assert.equal(typeof mod.mount, 'function', '导出的 mount 必须是函数');
  assert.ok(mod.default, '必须导出 default');
  assert.equal(typeof mod.default.mount, 'function', 'default.mount 必须是函数');

  const container = global.document.createElement('div');
  const api = {
    t: (key, opts) => (opts && opts.defaultValue) || key,
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

