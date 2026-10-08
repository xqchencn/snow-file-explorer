/**
 * SFC 逐行分节语言解析测试 (tests/src/components/sfc-highlight.test.ts)
 * @description Vue / Svelte 的高亮问题根因是「Prism 没有 SFC 语言组件，整篇被兜到 markup」，
 *   `<script>` / `<style>` 区块大片不上色。这里钉住分节解析的关键行为：
 *   区块体按 lang 属性取语言、区块标签行按 HTML、模板嵌套配对、自闭合不进区块。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSfcExt, sfcLineLangs } from '../../../src/components/sfc-highlight.ts';

const lines = (text: string) => text.split('\n');
const langsOf = (text: string) => sfcLineLangs(lines(text));

test('SFC: 扩展名识别（vue / svelte，大小写与前导点均容忍）', () => {
  assert.equal(isSfcExt('vue'), true);
  assert.equal(isSfcExt('.Vue'), true);
  assert.equal(isSfcExt('svelte'), true);
  assert.equal(isSfcExt('js'), false);
  assert.equal(isSfcExt(''), false);
});

test('SFC: .vue 三区块各自按 lang 属性取语言，开标签行按 HTML', () => {
  const text = [
    '<template>',
    '  <div class="a">{{ msg }}</div>',
    '</template>',
    '',
    '<script setup lang="ts">',
    'import { ref } from "vue";',
    'const msg = ref("hi");',
    '<\/script>',
    '',
    '<style lang="scss">',
    '.a { color: red; &.b { color: blue; } }',
    '<\/style>',
  ].join('\n');
  const langs = langsOf(text);
  assert.deepEqual(langs.slice(0, 3), ['markup', 'markup', 'markup'], '模板区与 </template> 按 HTML');
  assert.equal(langs[4], 'markup', '<script …> 开标签行按 HTML');
  assert.equal(langs[5], 'typescript', 'lang="ts" 的脚本体按 TypeScript');
  assert.equal(langs[6], 'typescript');
  assert.equal(langs[7], 'markup', '</script> 闭标签行按 HTML');
  assert.equal(langs[9], 'markup', '<style …> 开标签行按 HTML');
  assert.equal(langs[10], 'scss', 'lang="scss" 的样式体按 SCSS');
  assert.equal(langs[11], 'markup');
});

test('SFC: lang 缺省时 script 按 JavaScript、style 按 CSS', () => {
  const text = ['<script>', 'const a = 1;', '<\/script>', '<style>', '.a { color: red; }', '<\/style>'].join('\n');
  const langs = langsOf(text);
  assert.equal(langs[1], 'javascript');
  assert.equal(langs[4], 'css');
});

test('SFC: 模板区块内的嵌套 <template> 按深度配对，不会提前出块', () => {
  const text = [
    '<template>',
    '  <ul>',
    '    <template #item>',
    '      <li>{{ x }}</li>',
    '    </template>',
    '  </ul>',
    '</template>',
    '<script>',
    'const x = 1;',
    '<\/script>',
  ].join('\n');
  const langs = langsOf(text);
  // 嵌套 <template> 的行与其内的模板行都仍是 markup
  for (let i = 0; i <= 6; i += 1) {
    assert.equal(langs[i], 'markup', `第 ${i + 1} 行应仍在模板区块内`);
  }
  assert.equal(langs[8], 'javascript', '模板正确闭合后，脚本体按 JS');
});

test('SFC: 模板内出现 script/style 字样的行不会误开区块', () => {
  const text = ['<template>', '  <span>not a script tag</span>', '</template>', '<script>', 'const a = 1;', '<\/script>'].join('\n');
  const langs = langsOf(text);
  assert.equal(langs[1], 'markup', '模板行里的 script 字样不触发区块切换');
  assert.equal(langs[4], 'javascript');
});

test('SFC: 自闭合 script（外部引入）不改变区块状态', () => {
  const text = ['<script src="./x.ts" />', '<template>', '  <b>{{ 1 }}</b>', '</template>'].join('\n');
  const langs = langsOf(text);
  assert.equal(langs[1], 'markup', '自闭合后应仍在顶层，模板正常识别');
  assert.equal(langs[2], 'markup');
});

test('SFC: 区块外内容与未知标签按 HTML 兜底，整个文件不会抛错', () => {
  const text = ['<!-- 顶层注释 -->', '<docs lang="md">', '# 说明', '</docs>', '<template>', '  <i>x</i>', '</template>'].join('\n');
  const langs = langsOf(text);
  assert.equal(langs.length, lines(text).length, '输出必须与输入行数严格对齐');
  for (const lang of langs) assert.equal(typeof lang, 'string');
  assert.equal(langs[5], 'markup');
});

test('SFC: .svelte 同构处理', () => {
  const text = ['<script context="module">', 'export let x = 1;', '<\/script>', '<main>{x}</main>', '<style>', 'main { color: red; }', '<\/style>'].join('\n');
  const langs = langsOf(text);
  assert.equal(langs[1], 'javascript');
  assert.equal(langs[3], 'markup', 'svelte 模板体按 HTML 着色');
  assert.equal(langs[5], 'css');
});
