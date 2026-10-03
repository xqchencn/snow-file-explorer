/**
 * Snow App File Explorer 工业级构建与打包压缩脚本 (build.js)
 * 
 * 构建目标：
 * 将完整、自包含、可直接安装的插件发布物输出到 dist/ 目录：
 * dist/
 * ├── plugin.json         # 插件清单 (entry: index.js, styles: [index.css], locales)
 * ├── index.js            # 自包含 ESM 深度压缩代码
 * ├── index.css           # 深度压缩独立样式表
 * └── locales/            # 完整国际化多语言包 (en, zh-CN, zh-TW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runBuild() {
  console.log('🚀 [Build] 开始构建 Snow App 文件浏览器插件分发包 (dist/)...');
  const startTime = Date.now();

  const srcDir = path.join(__dirname, 'src');
  const distDir = path.join(__dirname, 'dist');
  const localesSrcDir = path.join(__dirname, 'locales');
  const localesDistDir = path.join(distDir, 'locales');

  // 1. 清理并重置 dist 目录及其子目录，确保产物绝对纯净
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(localesDistDir, { recursive: true });

  const jsEntry = path.join(srcDir, 'index.js');
  const distJsOut = path.join(distDir, 'index.js');

  const cssEntry = path.join(srcDir, 'index.css');
  const distCssOut = path.join(distDir, 'index.css');

  // 2. 打包并深度压缩 JavaScript (自包含 ESM)
  console.log('📦 [Build] 打包并压缩 JavaScript -> dist/index.js...');
  await esbuild.build({
    entryPoints: [jsEntry],
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['es2020', 'chrome80', 'node18'],
    outfile: distJsOut,
    treeShaking: true,
    legalComments: 'none',
  });

  const jsStat = fs.statSync(distJsOut);
  console.log(`✅ [Build] JavaScript 打包压缩完成: ${(jsStat.size / 1024).toFixed(1)} KB`);

  // 3. 打包并深度压缩 CSS
  console.log('🎨 [Build] 打包并压缩 CSS -> dist/index.css...');
  await esbuild.build({
    entryPoints: [cssEntry],
    bundle: true,
    minify: true,
    outfile: distCssOut,
    legalComments: 'none',
  });

  const cssStat = fs.statSync(distCssOut);
  console.log(`✅ [Build] CSS 打包压缩完成: ${(cssStat.size / 1024).toFixed(1)} KB`);

  // 4. 复制多语言包到 dist/locales/
  console.log('🌐 [Build] 同步多语言包至 dist/locales/...');
  const localeFiles = fs.readdirSync(localesSrcDir);
  for (const file of localeFiles) {
    if (file.endsWith('.json')) {
      fs.copyFileSync(path.join(localesSrcDir, file), path.join(localesDistDir, file));
    }
  }

  // 5. 生成 dist/plugin.json
  //    版本号 / 作者 / 许可等元数据以 package.json 为唯一来源（单一维护点），
  //    plugin.json 只保留宿主特有字段（id / name / panels / icon 等），
  //    升级版本号时只需改 package.json 一处，避免两处重复维护导致漂移。
  console.log('📄 [Build] 组装分发清单 dist/plugin.json...');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const rootManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8'));
  if (!pkg.version) {
    throw new Error('package.json 缺少 version 字段，无法生成插件清单');
  }
  const distManifest = {
    ...rootManifest,
    version: pkg.version,
    author: pkg.author || rootManifest.author,
    license: pkg.license || rootManifest.license,
    entry: 'index.js',
    styles: ['index.css'],
    locales: {
      'zh-CN': 'locales/zh-CN.json',
      'zh-TW': 'locales/zh-TW.json',
      'en': 'locales/en.json',
    },
  };
  fs.writeFileSync(path.join(distDir, 'plugin.json'), JSON.stringify(distManifest, null, 2), 'utf8');

  // 6. 验证 dist 产物自包含性与动态加载能力
  console.log('🧪 [Build] 验证 dist 独立可安装包加载状态...');
  const bundledSource = fs.readFileSync(distJsOut, 'utf8');

  // 严格检查相对 import 语句
  const relativeImportMatch = bundledSource.match(/import\s*.*?from\s*['"]\.\.?\/[^'"]+['"]/);
  if (relativeImportMatch) {
    throw new Error(`dist/index.js 存在非法的相对路径 import: ${relativeImportMatch[0]}`);
  }

  // 模拟宿主通过 data: URI (类似于 blob: URL) 动态导入
  const dataUri = 'data:text/javascript;base64,' + Buffer.from(bundledSource).toString('base64');
  const mod = await import(dataUri);

  if (typeof mod.mount !== 'function' && (!mod.default || typeof mod.default.mount !== 'function')) {
    throw new Error('dist/index.js 未导出标准的 mount 函数！');
  }

  const duration = Date.now() - startTime;
  console.log(`🎉 [Build] dist/ 独立可安装插件包构建完成！耗时: ${duration}ms\n`);
}

runBuild().catch((err) => {
  console.error('❌ [Build] 构建失败:', err);
  process.exit(1);
});
