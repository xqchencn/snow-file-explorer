import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  exitRightPanelFullscreen,
  isRightPanelFullscreen,
} from '../../../src/utils/panel-fullscreen.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

test('右面板全屏: 等待宿主异步 React 状态完成后才返回已退出', async () => {
  const shell = document.createElement('div');
  shell.className = 'app-shell right-panel-fullscreen';
  const panel = document.createElement('aside');
  panel.className = 'right-panel fullscreen';
  const button = document.createElement('button');
  button.className = 'right-panel-fullscreen-btn';
  button.addEventListener('click', () => {
    // 模拟宿主 setState + React 提交，不把 DOM class 当成同步副作用。
    setTimeout(() => {
      shell.classList.remove('right-panel-fullscreen');
      panel.classList.remove('fullscreen');
      button.setAttribute('aria-label', 'Right panel fullscreen');
    }, 30);
  });
  panel.appendChild(button);
  shell.appendChild(panel);
  document.body.appendChild(shell);

  assert.equal(await exitRightPanelFullscreen(), true);
  assert.equal(document.querySelector('.right-panel.fullscreen'), null);
  assert.equal(document.querySelector('.app-shell.right-panel-fullscreen'), null);
  shell.remove();
});

test('右面板全屏: React 重建期间优先点击带 Exit 标签的当前按钮', async () => {
  const shell = document.createElement('div');
  shell.className = 'app-shell right-panel-fullscreen';
  const panel = document.createElement('aside');
  panel.className = 'right-panel fullscreen';
  panel.dataset.snowAnchor = 'rightPanel';

  const staleButton = document.createElement('button');
  staleButton.className = 'right-panel-fullscreen-btn';
  staleButton.setAttribute('aria-label', 'Right panel fullscreen');
  const activeButton = document.createElement('button');
  activeButton.className = 'right-panel-fullscreen-btn';
  activeButton.setAttribute('aria-label', '退出右侧面板全屏');
  activeButton.addEventListener('click', () => {
    setTimeout(() => {
      shell.classList.remove('right-panel-fullscreen');
      panel.classList.remove('fullscreen');
    }, 5);
  });
  panel.append(staleButton, activeButton);
  shell.appendChild(panel);
  document.body.appendChild(shell);

  assert.equal(await exitRightPanelFullscreen(), true);
  assert.equal(document.querySelector('.right-panel.fullscreen'), null);
  assert.equal(isRightPanelFullscreen(), false);
  shell.remove();
});

test('右面板全屏: class 尚未同步但按钮已是 Exit 时仍执行退出', async () => {
  const panel = document.createElement('aside');
  panel.className = 'right-panel';
  panel.dataset.snowAnchor = 'rightPanel';
  const button = document.createElement('button');
  button.className = 'right-panel-fullscreen-btn';
  button.setAttribute('aria-label', 'Exit right panel fullscreen');
  button.addEventListener('click', () => {
    setTimeout(() => panel.remove(), 5);
  });
  panel.appendChild(button);
  document.body.appendChild(panel);

  assert.equal(await exitRightPanelFullscreen(), true);
  assert.equal(panel.isConnected, false);
});
