/**
 * 注释/文档引用卫生检查。
 *
 * 规矩：指向**本仓文件**的引用只写路径 + 符号名，不写行号；指向**宿主 snow-app 文件**的引用
 * 保留行号，因为宿主按 commit 钉住、快照漂移由 `npm run check:host` 把关。
 * 例外：`src/types/host/**` 是宿主的逐字镜像，行号即宿主行号，允许引用。
 *
 * 为什么要有这条：TS 化过程中 index.ts 的 102 处自指行号有 101 处随迁移错位，
 * 而错位的数字比没有数字更坏——读的人会把注释里的行当成真凭据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'tests', 'docs'];
const SCAN_FILES = ['README.md'];
const COORD = /(?:([\w./@-]+\.(?:tsx|jsx|mjs|ts|js|rs|md|json|css|html))\s*)?[:#](\d{2,4})(?!\d)/g;

/** 递归收集待扫描文件（宿主角色的镜像目录本身不审，它必须与宿主逐字一致）。 */
function collect(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'host') continue;
      collect(abs, acc);
    } else if (/\.(ts|js|mjs|md)$/.test(entry.name)) {
      acc.push(abs);
    }
  }
  return acc;
}

const files = [
  // docs/ 不入库，全新检出（CI）里它根本不存在；缺目录要跳过，不能让 readdirSync 抛 ENOENT
  // 把整个测试文件带走。下面 SCAN_FILES 已经是同样的兜法。
  ...SCAN_DIRS.map((d) => path.join(rootDir, d)).filter((d) => fs.existsSync(d)).flatMap((d) => collect(d)),
  ...SCAN_FILES.map((f) => path.join(rootDir, f)).filter((f) => fs.existsSync(f)),
];

/** 该行是否只该被读作散文/注释：代码行里的 a:b 不是引用。 */
function isProseLine(text: string, isMarkdown: boolean): boolean {
  if (isMarkdown) return true;
  return /^\s*(\/\/|\*|\/\*!?)/.test(text);
}

/** 引用目标是否是本仓文件（宿主机不在此仓库内，解析不到即视为外部引用）。 */
function resolvesInRepo(rel: string): boolean {
  if (rel.startsWith('src/types/host/')) return false;
  return fs.existsSync(path.join(rootDir, rel));
}

const violations: string[] = [];
for (const abs of files) {
  const relFile = path.relative(rootDir, abs).replace(/\\/g, '/');
  const isMarkdown = relFile.endsWith('.md');
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    if (!isProseLine(text, isMarkdown)) return;
    let lastPath: string | null = null;
    for (const m of text.matchAll(COORD)) {
      const [, pathPart, lineNo] = m;
      if (pathPart) lastPath = pathPart;
      if (!lastPath) continue;
      if (resolvesInRepo(lastPath)) {
        violations.push(`${relFile}:${i + 1} 指向本仓文件的行号 ${lastPath}:${lineNo} —— 改写成符号名`);
      }
    }
  });
}

test('引用卫生：注释与文档里不得用行号引用本仓文件', () => {
  assert.deepEqual(violations, [], `发现 ${violations.length} 处行号引用：\n${violations.join('\n')}`);
});
