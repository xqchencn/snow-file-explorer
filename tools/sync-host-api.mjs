#!/usr/bin/env node
/**
 * 宿主（Snow App）类型真源快照工具。
 *
 * 插件要类型化地调用宿主原始 API（window.snow）与宿主注入的插件运行时 API（mount 的第二参数），
 * 但 snow-app 既不是 npm 依赖也不参与插件构建。因此把宿主侧相关类型模块按传递闭包拷进
 * src/types/host/ 作为快照：唯一改动方式是重跑本工具，CI 用 --check 校验快照与宿主源码是否漂移。
 *
 * 拷贝时会重写相对 import 说明符以适配扁平目录，校验和记的是「重写后」的确定性输出，
 * 所以 --check 既能发现宿主源码变更，也能发现有人手改了快照。
 *
 * 用法：
 *   node tools/sync-host-api.mjs            # 生成/更新快照
 *   node tools/sync-host-api.mjs --check    # 只校验，漂移则退出码 1
 *
 * 宿主源码位置用环境变量 SNOW_APP_ROOT 覆盖。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const HOST_ROOT = process.env.SNOW_APP_ROOT || 'D:/app/code/snow-app';
const VENDOR_DIR = path.join(repoRoot, 'src', 'types', 'host');
const SNAPSHOT_FILE = path.join(VENDOR_DIR, 'snapshot.json');

/**
 * 允许进入快照的宿主目录（前缀 -> 目录 -> 起始模块）。
 * 闭包内任何相对导入若解析到这些目录之外，说明该模块含运行时依赖、不可逐字快照，直接报错。
 */
const SOURCE_GROUPS = [
  {
    prefix: 'host',
    dir: 'src/preload/types',
    roots: ['workspace', 'git', 'api', 'settings', 'ssh', 'plugins'],
  },
  {
    prefix: 'plugin',
    dir: 'src/renderer/plugins',
    roots: ['types', 'writes/types'],
  },
  {
    prefix: 'shared',
    dir: 'src/shared',
    roots: ['locale'],
  },
];

const ALLOWED_DIRS = SOURCE_GROUPS.map((group) => group.dir);

const checkOnly = process.argv.includes('--check');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const toPosix = (p) => p.replace(/\\/g, '/');

const hostPathOf = (repoRelPath) => path.join(HOST_ROOT, repoRelPath);

/** 宿主仓库相对路径 -> 快照输出模块名。 */
const outputNameOf = (repoRelPath) => {
  const withoutExt = repoRelPath.replace(/^\/|\.ts$/g, '');
  for (const group of SOURCE_GROUPS) {
    if (withoutExt.startsWith(`${group.dir}/`)) {
      const tail = withoutExt.slice(group.dir.length + 1).replace(/\//g, '-');
      return `${group.prefix}-${tail}.ts`;
    }
  }
  throw new Error(`路径不在允许快照的宿主目录内：${repoRelPath}`);
};

const isAllowed = (repoRelPath) => ALLOWED_DIRS.some((dir) => repoRelPath.startsWith(`${dir}/`));

/** 以仓库相对路径做相对解析，始终带 .ts 后缀（path.posix.resolve 会拿 cwd 当根，故显式加 /）。 */
const resolveSpec = (fromRepoRel, spec) => {
  const abs = path.posix.resolve(`/${path.posix.dirname(fromRepoRel)}`, spec);
  const withoutExt = abs.slice(1).replace(/\.ts$/, '');
  return `${withoutExt}.ts`;
};

/** 收集传递闭包：解析每个文件里的相对 import/export 说明符。 */
const collectClosure = () => {
  const queue = [];
  for (const group of SOURCE_GROUPS) {
    for (const root of group.roots) queue.push(`${group.dir}/${root}.ts`);
  }

  const byName = new Map();
  const seen = new Set();

  while (queue.length > 0) {
    const repoRel = toPosix(queue.shift());
    if (seen.has(repoRel)) continue;
    seen.add(repoRel);

    const file = hostPathOf(repoRel);
    if (!fs.existsSync(file)) throw new Error(`宿主类型文件不存在：${file}`);
    const text = fs.readFileSync(file, 'utf8');

    const specifiers = [
      ...text.matchAll(/from\s+["'](\.[^"']+)["']/g),
      ...text.matchAll(/export\s+\*\s+from\s+["'](\.[^"']+)["']/g),
    ].map((m) => m[1]);

    for (const spec of specifiers) {
      const dep = resolveSpec(repoRel, spec);
      if (!isAllowed(dep)) {
        throw new Error(
          `${repoRel} 依赖了不可快照的模块 ${dep}（含运行时依赖或不在允许目录）。` +
            ' 该类型需手写镜像，且必须放在 src/types/ 下（本目录会被全量重写）。',
        );
      }
      queue.push(dep);
    }

    byName.set(outputNameOf(repoRel), { repoRel, text });
  }

  return new Map([...byName.entries()].sort(([a], [b]) => a.localeCompare(b)));
};

/** 把相对说明符改写成扁平目录下的兄弟模块名。 */
const rewriteSpecifiers = (text, repoRel, closure) =>
  text.replace(/((?:from|export\s+\*)\s+["'])(\.[^"']+)(["'])/g, (match, head, spec, tail) => {
    const resolved = resolveSpec(repoRel, spec);
    const name = outputNameOf(resolved);
    if (!closure.has(name)) throw new Error(`${repoRel} 引用了未收录的模块 ${resolved}`);
    return `${head}./${name}${tail}`;
  });

const build = () => {
  const closure = collectClosure();
  const files = new Map();
  for (const [name, entry] of closure) {
    const text = rewriteSpecifiers(entry.text, entry.repoRel, closure);
    files.set(name, { source: entry.repoRel, sha256: sha256(text), text });
  }

  const barrel = [
    '// 本目录由 tools/sync-host-api.mjs 从 Snow App 宿主源码逐字生成，请勿手工编辑。',
    '// 重生成：node tools/sync-host-api.mjs   （CI 用 --check 校验与宿主是否漂移）',
    '',
    ...[...files.keys()].map((name) => `export type * from "./${name}";`),
    '',
  ].join('\n');
  files.set('index.ts', {
    source: '(生成：快照内模块的类型汇总出口)',
    sha256: sha256(barrel),
    text: barrel,
  });

  return files;
};

const hostCommitOf = () => {
  try {
    return execFileSync('git', ['-C', HOST_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const main = () => {
  const hostAvailable = fs.existsSync(HOST_ROOT);

  if (checkOnly) {
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      console.error('❌ 快照缺失：src/types/host/snapshot.json，请先运行 node tools/sync-host-api.mjs');
      process.exit(1);
    }
    const recorded = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

    // 第一层：快照有没有被手改。只依赖仓库内文件，CI 拿不到宿主仓库时也能校验。
    const tampered = [];
    for (const [name, meta] of Object.entries(recorded.files ?? {})) {
      const current = path.join(VENDOR_DIR, name);
      if (!fs.existsSync(current)) {
        tampered.push(`${name}（文件缺失）`);
        continue;
      }
      if (sha256(fs.readFileSync(current, 'utf8')) !== meta.sha256) {
        tampered.push(`${name}（内容被手改）`);
      }
    }
    for (const name of fs.readdirSync(VENDOR_DIR)) {
      if (name.endsWith('.ts') && !recorded.files?.[name]) tampered.push(`${name}（不在快照清单内）`);
    }
    if (tampered.length > 0) {
      console.error('❌ 宿主类型快照被手改；本目录只允许由 tools/sync-host-api.mjs 生成：');
      for (const item of tampered) console.error(`   - ${item}`);
      process.exit(1);
    }

    // 第二层：快照是否仍跟随宿主源码。仅在本机能读到 snow-app 时才做。
    if (!hostAvailable) {
      console.log(
        `✅ 宿主类型快照自洽（宿主 commit ${recorded.sourceCommit}）；` +
          `未找到 ${HOST_ROOT}，跳过与宿主源码的漂移校验。`,
      );
      return;
    }
    const files = build();
    const drift = [];
    for (const [name, meta] of files) {
      if (!recorded.files?.[name]) drift.push(`${name}（宿主新增）`);
      else if (recorded.files[name].sha256 !== meta.sha256) drift.push(`${name}（内容已变化）`);
      else if (recorded.files[name].source !== meta.source) drift.push(`${name}（来源路径变化）`);
    }
    for (const name of Object.keys(recorded.files ?? {})) {
      if (!files.has(name) && name !== 'snapshot.json') drift.push(`${name}（宿主已删除）`);
    }
    if (drift.length > 0) {
      console.error('❌ Snow App 宿主类型已漂移，快照落后于宿主源码：');
      for (const item of drift) console.error(`   - ${item}`);
      console.error(`   宿主当前 commit：${hostCommitOf()}（快照记录：${recorded.sourceCommit}）`);
      console.error('   运行 node tools/sync-host-api.mjs 重新同步，并按 docs/host-api.md 复核签名。');
      process.exit(1);
    }
    console.log(
      `✅ 宿主类型快照自洽且与 Snow App（${recorded.sourceCommit}）一致：${files.size} 个文件`,
    );
    return;
  }

  if (!hostAvailable) {
    console.error(`❌ 找不到宿主仓库：${HOST_ROOT}`);
    console.error('   用 SNOW_APP_ROOT=<snow-app 路径> 指定后重试。');
    process.exit(2);
  }

  const files = build();

  // 全量重写：先清掉旧的 .ts，避免宿主已删除的模块残留成孤儿类型。
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  for (const existing of fs.readdirSync(VENDOR_DIR)) {
    if (existing.endsWith('.ts')) fs.rmSync(path.join(VENDOR_DIR, existing));
  }
  for (const [name, meta] of files) {
    fs.writeFileSync(path.join(VENDOR_DIR, name), meta.text, 'utf8');
  }

  const snapshot = {
    hostRoot: HOST_ROOT.replace(/\\/g, '/'),
    sourceCommit: hostCommitOf(),
    syncedAt: new Date().toISOString().slice(0, 10),
    rootModules: SOURCE_GROUPS.map((group) => ({
      dir: group.dir,
      prefix: group.prefix,
      roots: group.roots,
    })),
    files: Object.fromEntries(
      [...files.entries()].map(([name, meta]) => [name, { source: meta.source, sha256: meta.sha256 }]),
    ),
  };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  console.log(`✅ 已同步宿主类型快照（${files.size} 个文件）：`);
  for (const [name, meta] of files) console.log(`   ${name}  <=  ${meta.source}`);
  console.log(`   宿主 commit：${snapshot.sourceCommit}`);
};

main();
