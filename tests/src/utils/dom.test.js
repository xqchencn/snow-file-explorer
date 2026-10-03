import test from 'node:test';
import assert from 'node:assert/strict';
import { humanSize, escapeHtml } from '../../../src/utils/dom.js';

test('DOM 工具: humanSize 格式化', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(1024), '1.0 KB');
  assert.equal(humanSize(1536), '1.5 KB');
  assert.equal(humanSize(1048576), '1.0 MB');
  assert.equal(humanSize(-1), '');
  assert.equal(humanSize(null), '');
});

test('DOM 工具: escapeHtml 转义特殊符号', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("Tom & 'Jerry'"), 'Tom &amp; &#39;Jerry&#39;');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
});