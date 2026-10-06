import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'tmp/**',
      'index.js',
      'index.css',
      'style.css',
      // 宿主类型快照由 tools/sync-host-api.mjs 逐字生成，必须与 Snow App 源码保持一致，
      // 不参与本仓库的 lint / 格式化（改了会被 --check 判定为漂移）。
      'src/types/host/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      // 由 TypeScript 负责未声明标识符的检查，避免与全局类型声明重复报错。
      'no-undef': 'off',
    },
  },
  {
    // 构建脚本与工具跑在 Node，类型声明里允许出现宿主 API 之外的全局。
    files: ['build.js', 'tools/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // 插件源码额外开一条需要类型信息的规则：`no-floating-promises`。
    // 只这一条——整套 recommendedTypeChecked 会把几百处 `=== true` 之类的真值归一一起打翻。
    // 开它的理由：宿主 api.storage / window.snow 的方法全是 async，而本插件多处是「同步 try/catch 包住 async 调用」
    // 的写法，拒绝逃逸出 try 变成 unhandled rejection，本意的告警一次都不会打；tsc 与不带类型信息的 eslint 都看不见。
    // build.js 与 tools/ 不在 tsconfig 的 JS 解析范围内，故只对 src 开。
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
