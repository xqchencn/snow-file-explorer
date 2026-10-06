/**
 * HTTP 请求视图控制器 (src/controllers/http-controller.ts)
 * @description 「HTTP 请求」主视图的数据与交互：整仓扫描 `.http` / `.rest` 文件、目录折叠、
 *   打开文件并解析成请求清单、GUI 卡片与文本形态互切、改动写回正文、焦点离开就落盘、发送请求并收响应。
 *   右侧查看器的正文通道不在这里另起一套：请求文件首先是文本文件，
 *   读取 / 高亮 / 编辑 / 保存一律复用 preview-controller 的 state.preview，
 *   本控制器只额外给出行号槽上的 ▶ 与「何时该落盘」。
 * @description 折叠态只有一份：`state.httpExpanded` 存卡片键（`r<下标>`），脏标记也只有 `state.httpDirty` 一条；
 *   两处各记一份必然对不上，两个形态切换看的始终是同一份正文。
 */

import type { PluginRuntimeApi } from "../types/plugin-runtime.ts";
import type { TranslateFn, HttpViewerMode } from "../types/panel-state.ts";
import type { PanelState } from "../state/panel-state.ts";
import { createPanelState, pathKey } from "../state/panel-state.ts";
import type { FileTreeEntry } from "../services/file-service.ts";
import { basename, errorMessage } from "../services/file-service.ts";
import type { HttpRestFile } from "../services/http-file-scan.ts";
import { scanHttpRestFiles } from "../services/http-file-scan.ts";
import { parseHttpFile, httpRequestTitle } from "../services/http-request-parser.ts";
import type { HttpParsedFile, HttpParsedRequest } from "../services/http-request-parser.ts";
import { formValuesOfRequest, updateHttpText } from "../services/http-serialize.ts";
import type { HttpFormValues } from "../services/http-serialize.ts";
import { runHttpRequest } from "../services/http-runner.ts";
import type { HttpRunResult } from "../services/http-runner.ts";
import { saveHttpViewerMode } from "../services/settings.ts";
import type { HttpResponseRecord } from "../services/http-variables.ts";

/** HTTP 控制器的注入依赖：渲染回调与跨控制器回调由装配阶段回填。 */
export type HttpControllerDeps = {
  /** 面板状态对象（与其余控制器同一份）。 */
  state: PanelState;
  /** 翻译函数。 */
  t: TranslateFn;
  /** 宿主插件运行时 API；发送走其中的 `api.net.fetch`。 */
  api: PluginRuntimeApi;
  /** 面板是否已卸载。 */
  isDisposed(): boolean;
  /** 重绘左侧请求文件列表。 */
  renderHttpPane(): void;
  /** 重绘右侧查看器（GUI 或文本）。 */
  renderHttpPreview(): void;
  /**
   * 只重绘文本态右分栏（请求体 + 响应），不碰左边的代码查看器。
   * @description 文本态下左边的编辑区重建会销毁 textarea（丢光标），
   *   还会把用户刚点的行号 ▶ 在 click 派发前摘掉，所以结果刷新只走这一条窄通道。
   */
  renderHttpResultPane?(): void;
  /** 跨控制器回调：走文件预览通道打开请求文件（读取 / 高亮 / 全屏联动都在里面）。 */
  previewFile(entry: FileTreeEntry): Promise<void>;
  /** 跨控制器回调：把缓冲里的正文写盘（保存通道仍归 preview-controller）。 */
  savePreview(): Promise<void>;
  /**
   * 在面板状态条上写一行文案，空串即清除。
   * @description 文本态没有卡片可挂进行态与结果（响应只在 GUI 卡片里渲染），
   *   发送这件事就在这条既有通道上给回音，免得点了行号上的 ▶ 之后界面一动不动。
   * @param text 文案
   * @param persistent 为真时不自动清除，由后续动作显式清掉（文本态的「未保存」就是这种）
   */
  setStatus?(text: string, persistent?: boolean): void;
  /**
   * 问一句「未保存的改动继续就丢」。
   * @returns 用户确认继续时 true
   * @description 换文件会把缓冲里的改动连同解析结果一起丢掉，这条路上必须先问；
   *   切项目（resetForProject）不问——那时项目已经切过去了，问也来不及。
   */
  confirmDiscard?(): Promise<boolean>;
};

/**
 * 一条请求的身份指纹。
 * @param request 解析出的请求；缺省时返回空串
 * @returns 名字 + 方法 + 地址拼成的指纹
 * @description 请求在下标位置上会随文本编辑漂移，响应与请求变量都按「下标」记账，
 *   所以「这一格还是不是同一条请求」只能靠指纹判，不能靠下标本身。
 */
function requestIdentity(request: HttpParsedRequest | null | undefined): string {
  if (!request) return "";
  return `${request.name || ""}\u0000${request.method.toUpperCase()} ${request.url}`;
}

/**
 * 创建 HTTP 请求视图控制器。
 * @param deps 注入依赖
 * @returns 扫描 / 打开 / 折叠 / 表单 / 发送等动作集合
 */
export function createHttpController(deps: HttpControllerDeps) {
  const { state, t, api } = deps;
  const isDisposed = deps.isDisposed;

  /** 扫描令牌：每次启动 +1，晚到的旧结果一律丢弃（切项目 / 连点刷新都会撞上这一条）。 */
  let scanToken = 0;
  /** 已成功完成扫描的工作区根键；与当前根不一致时才重新扫描，避免每次切回视图都重跑整仓。 */
  let scannedRootKey = "";
  /** 发送令牌：换文件或重发时丢弃上一次的结果。 */
  let sendToken = 0;

  /**
   * 重新扫描整仓请求文件。
   * @description 忽略规则优先复用整仓收集好的那一份（state.gitignoreFullyLoaded 为真时），
   *   省掉逐层再读一遍 .gitignore；规则尚未齐时由扫描自身逐层补读。
   * @param [options.force] 强制重扫：绕过「本根已扫过」的短路。
   */
  async function rescan(options: { force?: boolean } = {}) {
    const rootPath = state.rootPath;
    if (!rootPath) {
      state.httpFiles = [];
      state.httpTruncated = false;
      state.httpScanFailed = 0;
      deps.renderHttpPane();
      return;
    }
    const rootKey = pathKey(rootPath);
    if (!options.force && scannedRootKey === rootKey && !state.httpScanning) return;
    const token = ++scanToken;
    state.httpScanning = true;
    deps.renderHttpPane();
    const rules = state.viewSettings.respectGitignore && state.gitignoreFullyLoaded ? state.gitignoreRules : null;
    const result = await scanHttpRestFiles({
      rootPath,
      respectGitignore: state.viewSettings.respectGitignore,
      gitignoreRules: rules,
      isCancelled: () => isDisposed() || token !== scanToken || pathKey(state.rootPath) !== rootKey,
    });
    if (isDisposed() || token !== scanToken || pathKey(state.rootPath) !== rootKey) return;
    state.httpScanning = false;
    state.httpFiles = result.files;
    state.httpTruncated = result.truncated;
    state.httpScanFailed = result.failedDirectories;
    // 清单变了，已打开的文件可能已不在其中：选中态跟着清单走才不骗人。
    if (state.httpSelected && !result.files.some((file) => pathKey(file.path) === pathKey(state.httpSelected || ""))) {
      state.httpSelected = null;
    }
    if (!result.cancelled) scannedRootKey = rootKey;
    deps.renderHttpPane();
  }

  /** 丢掉当前文件的解析结果与表单（换文件、切形态重读时用）。 */
  function releaseDocument() {
    state.httpFile = null;
    state.httpForms = new Map();
    state.httpResponses = new Map();
    state.httpRunning = null;
    // 换文件后右分栏也该回到「还没发过」：留着上一条的结果等于给新文件指错请求。
    state.httpResultIndex = null;
    state.httpPrompts = new Map();
    state.httpExpanded = new Set();
    state.httpBodyCollapsed = new Set();
    state.httpDirty = false;
  }

  /**
   * 按缓冲里的正文重算解析结果与表单初值，保留响应与提示值。
   * @description 文本态存过盘、或 GUI 改完要提交时走这里：正文是唯一事实，
   *   表单只是它的投影，重算一次就对上了。响应按请求下标挂着，
   *   重算不该把刚发出来的响应抹掉（下标变了自然对不上，那是改文本的应有代价）。
   * @returns 缓冲可用（已打开且仍是文本文件）时 true
   */
  function reparseBuffer(): boolean {
    const preview = state.preview;
    if (!preview || preview.kind !== "text" || pathKey(preview.path) !== pathKey(state.httpSelected || "")) return false;
    const before = state.httpFile;
    const file = parseHttpFile(preview.text || "");
    state.httpFile = file;
    const forms = new Map<number, HttpFormValues>();
    file.requests.forEach((request, index) => forms.set(index, formValuesOfRequest(request)));
    state.httpForms = forms;
    // 响应按下标挂着，而下标会随文本编辑漂移：只留「同一下标仍是同一条请求」的那些，
    // 否则 A 的响应会画到 B 的卡片下，请求变量还会拿 A 的响应体去填 B 的地址。
    if (before) {
      const kept = new Map<number, HttpRunResult>();
      for (const [index, result] of state.httpResponses) {
        const identity = requestIdentity(before.requests[index]);
        if (identity && identity === requestIdentity(file.requests[index])) kept.set(index, result);
      }
      state.httpResponses = kept;
    }
    return true;
  }

  /**
   * 用预览通道读到的正文重建解析结果与表单初值。
   * @description 文本态里用户存过盘、或刚在 GUI 里改过，都要从这里重新对账；
   *   只有 kind 为 text 才有正文（图片 / 二进制 / 错误态直接清空）。
   */
  function reloadDocument() {
    if (!reparseBuffer()) {
      releaseDocument();
      return;
    }
    state.httpResponses = new Map();
    state.httpPrompts = new Map();
  }

  /**
   * 让缓冲进入可编辑态。
   * @description 文本态一进去就是编辑态（不必先点「编辑」），保存通道也要求这一位为真。
   *   只在查看的确实是清单里选中的那个请求文件时置位，别把别的文件的预览改成可编。
   */
  function ensureEditableBuffer() {
    const preview = state.preview;
    if (!preview || preview.kind !== "text") return;
    if (pathKey(preview.path) !== pathKey(state.httpSelected || "")) return;
    if (preview.editable === true) return;
    state.preview = { ...preview, editable: true };
  }

  /**
   * 打开一个请求文件：选中态记在本控制器，正文交预览通道。
   * @param file 列表里的请求文件
   * @description 换文件会丢掉缓冲里的改动，先问一句；同一个文件重开不问。
   */
  async function openFile(file: HttpRestFile) {
    const switching = pathKey(state.httpSelected || "") !== pathKey(file.path);
    if (switching && isDirty() && typeof deps.confirmDiscard === "function") {
      const confirmed = await deps.confirmDiscard();
      if (isDisposed() || !confirmed) return;
    }
    if (switching) releaseDocument();
    state.httpSelected = file.path;
    deps.renderHttpPane();
    // previewFile 需要的是文件树条目形状；扫描结果按其字段就地构造，不再多走一次列目录。
    const entry: FileTreeEntry = {
      name: file.name,
      path: file.path,
      isDirectory: false,
      size: file.size,
    };
    await deps.previewFile(entry);
    if (isDisposed() || pathKey(state.httpSelected || "") !== pathKey(file.path)) return;
    reloadDocument();
    // 打开文件默认全部折叠：先给「这份文件有哪些请求」的清单，看哪条再点哪条。
    // （此处不再自动聚焦第一条——那会在用户还没选之前就摊开一条，等于替他做决定。）
    if (state.httpMode === "text") ensureEditableBuffer();
    deps.renderHttpPreview();
  }

  /**
   * 折叠 / 展开一个目录。
   * @param relPath 目录相对工作区根的路径
   */
  function toggleCollapse(relPath: string) {
    const next = new Set(state.httpCollapsed);
    if (next.has(relPath)) next.delete(relPath);
    else next.add(relPath);
    state.httpCollapsed = next;
    deps.renderHttpPane();
  }

  /**
   * 切换查看形态（GUI / 文本）并持久化偏好。
   * @param mode 目标形态；非 gui/text 按 gui 收。
   * @param persist 是否写入用户偏好；发送后临时切到 GUI 看结果时传 false，
   *   免得把「我偏好文本」顺手改成「我偏好 GUI」
   */
  function setMode(mode: HttpViewerMode, persist = true) {
    const next: HttpViewerMode = mode === "text" ? "text" : "gui";
    if (state.httpMode === next) return;
    state.httpMode = next;
    if (persist) saveHttpViewerMode(api, next);
    // 两个形态看的是同一份正文：切换时按缓冲重算解析结果与表单，已发出来的响应不清掉。
    reparseBuffer();
    // 文本态没有「先点编辑」这一步，进去就是编辑态。
    if (next === "text") ensureEditableBuffer();
    deps.renderHttpPreview();
  }

  /**
   * 切换一张请求卡片的聚焦态。
   * @param key 块键：请求卡片用 `r<下标>`
   * @description 一次只聚焦一条（对标 Postman 一次只编辑一个请求）：展开某条即聚焦它，
   *   其余自动收起成列表行；再点同一条则收起回到「全是列表行」的浏览态。
   *   非请求键（文本态其它块）保持普通的逐个切换。
   */
  function toggleExpand(key: string) {
    const next = new Set(state.httpExpanded);
    const focused = next.has(key);
    if (/^r\d+$/.test(key)) {
      // 只切「聚焦哪条卡片」；请求构建区的开合不在这里改——
      // 它由「这条发过没有」（响应表）派生，折叠再展开自然回到该条此刻该有的默认态。
      next.clear();
      if (!focused) next.add(key);
    } else if (focused) {
      next.delete(key);
    } else {
      next.add(key);
    }
    state.httpExpanded = next;
    deps.renderHttpPreview();
  }

  /**
   * 开合某条请求的构建区（请求头 / 提示变量 / 请求体）。
   * @param index 请求下标
   * @param open 摊开为 true、收起为 false
   * @description 构建区默认态由「这条请求发过没有」派生：没发过摊开供编辑，发过就收起让结果露出来。
   *   本方法只登记「用户手动偏离默认」的那一种（发过却要重开编辑、或没发就收起），
   *   所以折叠卡片再展开、切到别的请求再切回来，看到的都是该请求此刻该有的样子。
   */
  function setRequestBodyOpen(index: number, open: boolean) {
    const next = new Set(state.httpBodyCollapsed);
    if (open) next.delete(index);
    else next.add(index);
    state.httpBodyCollapsed = next;
    deps.renderHttpPreview();
  }

  /**
   * 聚焦某条请求（发送时调用，确保结果可见）。
   * @param index 请求下标
   */
  function expandRequest(index: number) {
    const key = `r${index}`;
    if (state.httpExpanded.size === 1 && state.httpExpanded.has(key)) return;
    state.httpExpanded = new Set([key]);
  }

  /**
   * 表单里改了一个字段：登记新值并把这一条请求写回正文。
   * @param index 请求下标
   * @param values 表单现值（含尚未落盘的输入）
   * @description 键入途中绝不重绘：重绘会销毁正在输入的框、光标跳回开头，
   *   与文件树 / Git 视图同一条规矩。卡片里各字段的显示值本来就是用户自己打的，
   *   标题与摘要等到焦点离开卡片提交时再刷新。
   */
  function handleFormChange(index: number, values: HttpFormValues) {
    const file = state.httpFile;
    if (!file || !file.requests[index]) return;
    if (state.httpMode !== "gui") return;
    const next = updateHttpText(state.preview.text || "", file, index, values);
    state.httpForms.set(index, values);
    if (next.text === state.preview.text) return;
    state.httpFile = next.file;
    state.preview.text = next.text;
    // 正文里写出的 `###` 就是新开一节：请求条数会变，说一句，别让用户以为是界面出错。
    if (next.file.requests.length !== file.requests.length) {
      if (typeof deps.setStatus === "function") {
        deps.setStatus(t("http.bodySectionHint", "正文里以 ### 开头的行会被当成新的分节行"));
      }
    }
    // 正文一改，整篇高亮 HTML 立刻作废（与 preview.handlePreviewInput 同一口径）。
    state.preview.highlightedHtml = "";
    state.preview.html = "";
    state.preview.saveState = "idle";
    state.preview.saveMessage = "";
    state.preview.editable = true;
    state.httpDirty = true;
  }

  /**
   * 文本态键入后只登记「正文动过」。
   * @description 正文本身由 preview-controller 的输入通道写进 state.preview，
   *   这里不另开一条，只把脏标记补上；重解析等焦点离开再统一做（见 commit）。
   *   文本态没有 GUI 的常驻脏条，所以顺带在面板状态条上挂一条「有未保存的改动」。
   */
  function markDirty() {
    state.httpDirty = true;
    if (typeof deps.setStatus === "function") deps.setStatus(t("http.unsaved", "有未保存的改动"), true);
  }

  /**
   * 文本态行号槽上的发送标记。
   * @returns 每条请求一项：`{ 行号（1 基）, 悬停文字, 请求下标 }`
   * @description ▶ 钉在请求行（`GET` / `POST` 那一行），不钉在 `### 标题` 行：
   *   标题只是给人看的名字，真正被发出去的是请求行，▶ 与它同行才指得准。
   *   `startLine` 已刨掉前导注释、空行与文件变量定义行，正是请求行本身。
   */
  function runMarkers(): Array<{ line: number; title: string; index: number }> {
    const file = state.httpFile;
    if (!file) return [];
    return file.requests.map((request, index) => ({
      line: request.startLine + 1,
      title: httpRequestTitle(request) || `${request.method} ${request.url}`,
      index,
    }));
  }

  /**
   * 焦点离开改动处：按缓冲重解析并写盘。
   * @description 保存仍走 preview-controller 那一条通道（写盘、Git 差异缓存作废、
   *   状态条文案都在里面），这里只负责「什么时候该落盘」。
   * @description 这里**不重建查看器**：文本态重建会销毁正在编辑的 textarea（丢光标与选区），
   *   也会在点击 ▶ 的 click 派发之前把那个按钮摘掉——用户看到的就是「点了没反应」。
   *   GUI 态本来也不需要：字段改动都经 handleFormChange 即时写回并重解析，
   *   折叠摘要与响应由发送/折叠/换文件那几条路径自己重绘。保存态与脏条走查看器的就地同步通道。
   */
  async function commit() {
    if (isDisposed()) return;
    reparseBuffer();
    if (state.httpDirty) {
      await deps.savePreview();
      if (isDisposed()) return;
      const saved = Boolean(state.preview && state.preview.saveState === "saved");
      if (saved) state.httpDirty = false;
      // 文本态的「未保存」是常驻状态条，落盘结果要在这里收口：成功就撤掉，失败就换成原因。
      if (state.httpMode === "text" && typeof deps.setStatus === "function") {
        deps.setStatus(saved ? "" : state.preview.saveMessage || t("action.saveFailed", "保存失败"), !saved);
      }
    }
  }

  /**
   * 记下 `# @prompt` 变量的填值。
   * @param index 请求下标
   * @param name 变量名
   * @param value 用户填的值
   */
  function handlePromptChange(index: number, name: string, value: string) {
    state.httpPrompts.set(`${index}:${name}`, value);
  }

  /** 取 `# @prompt` 变量已填的值。 */
  function promptValue(index: number, name: string): string {
    return state.httpPrompts.get(`${index}:${name}`) || "";
  }

  /**
   * 组出实际要发的请求：表单现值覆盖解析结果。
   * @param index 请求下标
   * @returns 可发请求；下标越界或没有代发通道时 null
   * @description 正文里的 `< 文件` 引用直接用解析结果里的那份：GUI 每次改动都会
   *   `updateHttpText` 写回并重解析，`parsed` 与表单的正文必然同源；
   *   在这里按 `bodyStart + 行下标` 重算行号是错的——请求块内的注释行已被剥掉，行号不连续。
   */
  function effectiveRequest(index: number): HttpParsedRequest | null {
    const file = state.httpFile;
    const parsed = file && file.requests[index];
    const values = state.httpForms.get(index);
    if (!parsed || !values) return null;
    const body = values.body === null ? null : String(values.body);
    const headers = values.headers
      .map((header, at) => ({
        name: header.name.trim(),
        value: String(header.value ?? ""),
        // 行号只用于展示与写回；表单里改了哪条就沿用原位置，新增的挂在块尾。
        line: parsed.headers[at] ? parsed.headers[at].line : parsed.headerEnd + 1,
      }))
      .filter((header) => header.name);
    return {
      ...parsed,
      method: values.method.trim().toUpperCase() || "GET",
      url: values.url.trim(),
      headers,
      body,
    };
  }

  /**
   * 收集会话里已发过的命名响应，供请求变量 `{{name.response.body...}}` 取值。
   * @returns 名字 → 响应记录
   */
  function responseRecords(): Map<string, HttpResponseRecord> {
    const out = new Map<string, HttpResponseRecord>();
    const file = state.httpFile;
    if (!file) return out;
    for (const [index, result] of state.httpResponses) {
      const name = file.requests[index] && file.requests[index].name;
      if (!name || !result.response) continue;
      out.set(name, {
        status: result.response.status,
        statusText: result.response.statusText,
        headers: result.response.headers,
        body: result.response.body,
      });
    }
    return out;
  }

  /**
   * 取本次请求的 `# @prompt` 填值。
   * @param file 当前文件的解析结果
   * @param index 请求下标
   * @returns 变量名 → 值；只含用户真填了的那些
   * @description 没填就等于没有这个变量：让它落进「未解析」，界面才会提示
   *   「有 N 处变量没换成值」，而不是把 `Authorization: Bearer ` 这种半截值静默发出去。
   */
  function promptValues(file: HttpParsedFile, index: number): Map<string, string> {
    const out = new Map<string, string>();
    const request = file.requests[index];
    for (const prompt of request ? request.prompts : []) {
      const value = promptValue(index, prompt.name);
      if (value !== "") out.set(prompt.name, value);
    }
    return out;
  }

  /**
   * 发送一条请求。
   * @param index 请求下标
   * @description 同一时刻只发一条：变量作用域与响应表都按请求下标挂，并发两条只会互相踩。
   *   GUI 靠按钮禁用挡重入，文本态的行号 ▶ 没有禁用态，这道闸就放在这里。
   */
  async function send(index: number) {
    if (state.httpRunning !== null) return;
    const file = state.httpFile;
    const request = effectiveRequest(index);
    if (!file || !request) return;
    const filePath = state.httpSelected || state.preview.path;
    const identity = requestIdentity(file.requests[index]);
    const fetch = api && api.net && typeof api.net.fetch === "function" ? api.net.fetch.bind(api.net) : null;
    const report = (text: string) => {
      if (typeof deps.setStatus === "function") deps.setStatus(text);
    };
    if (!fetch) {
      state.httpResponses.set(index, {
        sent: { method: request.method, url: request.url, headers: {}, body: request.body },
        response: null,
        error: t("http.err.noChannel", "当前环境不能发起网络请求"),
        unresolved: [],
        warnings: [],
        attempted: false,
      });
      report(t("http.err.noChannel", "当前环境不能发起网络请求"));
      refreshResult(index);
      return;
    }
    const token = ++sendToken;
    state.httpRunning = index;
    // 折叠态下点 ▶ 也要看得见响应：发出去就把这一条摊开。
    expandRequest(index);
    report(t("http.sending", "发送中…"));
    // 文本态不重绘左边的代码：那会销毁正在编辑的 textarea 与光标，
    // 也会在 click 派发前把刚点的 ▶ 摘掉（表现为「点了没反应」）。状态条已经在说「发送中」。
    if (state.httpMode === "gui") deps.renderHttpPreview();
    let result: HttpRunResult;
    try {
      result = await runHttpRequest(request, file, {
        fetch,
        t,
        filePath,
        rootPath: state.rootPath,
        scope: {
          // 文件变量交给 runHttpRequest 从 file 上取；这里只带本次请求的 prompt 值与既有响应。
          fileVariables: new Map(),
          prompts: promptValues(file, index),
          responses: responseRecords(),
        },
      });
    } catch (err) {
      // 服务层本该把失败收敛成返回值（见 file-service 的 FileWriteResult），
      // 但这条路是最后一道闸：异常漏出去就是未捕获的 rejection，
      // httpRunning 永远不复位，整个文件的发送按钮一起锁死。
      result = {
        sent: { method: request.method, url: request.url, headers: {}, body: request.body },
        response: null,
        error: errorMessage(err),
        unresolved: [],
        warnings: [],
        attempted: true,
      };
    }
    if (isDisposed() || token !== sendToken) return;
    // 先复位再判定：这个复位是「发送按钮能不能再按」的唯一开关，任何返回路径都必须走到。
    state.httpRunning = null;
    // 在飞期间文档可能被重解析（焦点离开卡片、切形态、改表单都会重解析）。
    // 判定要用「选中文件 + 请求指纹」，不能用 `state.httpFile` 的对象身份：
    // 重解析每次都是新对象，用身份判定会把同一个文件的正常重解析误判成换了文件，
    // 于是响应被丢掉、httpRunning 永久卡在发送中。
    const sameFile = pathKey(state.httpSelected || state.preview.path) === pathKey(filePath);
    const stillSameRequest = requestIdentity(state.httpFile?.requests[index]) === identity;
    if (sameFile && identity && stillSameRequest) {
      state.httpResponses.set(index, result);
    }
    report(
      result.response
        ? t("http.sendDone", "{{status}} · {{ms}} 毫秒", {
            status: `${result.response.status} ${result.response.statusText}`.trim(),
            ms: result.response.elapsedMs,
          })
        : t("http.sendFailed", "发送失败：{{error}}", { error: result.error || t("http.notSent", "未发出") })
    );
    // 文本态右侧就是「请求体 + 响应」分栏：只刷这一栏，不碰左边的编辑区。
    refreshResult(index);
  }

  /**
   * 结果变了之后刷新界面。
   * @param index 这次结果对应的请求下标
   * @description 文本态只刷右分栏：左边的代码查看器重建会销毁 textarea（丢光标与选区），
   *   也会把用户刚点的 ▶ 在 click 派发前摘掉——那正是「点了没反应」的成因。
   */
  function refreshResult(index: number) {
    state.httpResultIndex = index;
    // 请求已经发出去：这一条此后默认收起构建区，只把结果留在眼前。
    // 记在「已收起」集合里（而不是一个全局开关），所以切到别的请求、折叠再展开，
    // 回来看这条仍然是「结果在上、请求区收起」——不会被别的请求的展开态带偏。
    const collapsed = new Set(state.httpBodyCollapsed);
    collapsed.add(index);
    state.httpBodyCollapsed = collapsed;
    if (state.httpMode === "text" && typeof deps.renderHttpResultPane === "function") {
      deps.renderHttpResultPane();
      return;
    }
    deps.renderHttpPreview();
  }

  /**
   * 切回「HTTP 请求」主视图时校正右侧查看器。
   * @returns 是否做了清场
   * @description 清单选中项与正文缓冲对不上时必须两边一起清：只清正文会留下
   *   「有解析结果、没有正文」的半截状态——GUI 照样画得出卡片，但任何改动都会写进空缓冲
   *   （updateHttpText 拿空串当原文），保存又因没有路径静默失败，脏标记永远清不掉。
   */
  function syncWithSelection(): boolean {
    if (pathKey(state.preview.path) === pathKey(state.httpSelected || "")) {
      if (state.httpMode === "text") ensureEditableBuffer();
      return false;
    }
    releaseDocument();
    state.preview = { ...createPanelState().preview };
    return true;
  }

  /**
   * 切换工作区时清场：旧根的清单、折叠与已开文件都不该带进新根。
   */
  function resetForProject() {
    scanToken += 1;
    sendToken += 1;
    scannedRootKey = "";
    state.httpFiles = [];
    state.httpTruncated = false;
    state.httpScanFailed = 0;
    state.httpScanning = false;
    state.httpCollapsed = new Set();
    state.httpSelected = null;
    releaseDocument();
  }

  /**
   * 「按 .gitignore 过滤」开关变化后作废缓存的扫描根：清单内容直接受它影响。
   */
  function invalidateScan() {
    scannedRootKey = "";
  }

  /**
   * 缓冲里是否仍有改动没写盘（GUI 与文本两个态共用这一条事实）。
   * @description 不能用 `preview.editable` 当脏标记：文本态一进去就是编辑态，那样一是打开就显示「未保存」。
   *   脏只在正文真的被改过时置位，写盘成功由保存通道置回 saved；
   *   失败时留着 true，界面上的保存条才不会被误清。
   * @returns 有未保存改动时 true
   */
  function isDirty(): boolean {
    if (state.httpDirty !== true) return false;
    return state.preview.saveState !== "saved";
  }

  /**
   * 丢弃缓冲里的改动，回到磁盘上的原文。
   */
  async function discardChanges() {
    releaseDocument();
    state.preview = { ...state.preview, editable: false, saveState: "idle", saveMessage: "" };
    await deps.previewFile({
      name: selectedName(),
      path: state.httpSelected || state.preview.path,
      isDirectory: false,
    } as FileTreeEntry);
    reloadDocument();
    if (state.httpMode === "text") ensureEditableBuffer();
    deps.renderHttpPreview();
  }

  /** 文件名（空态与标题用）。 */
  function selectedName(): string {
    return state.httpSelected ? basename(state.httpSelected) : "";
  }

  /**
   * 文本态右分栏该显示哪一条请求的结果。
   * @returns 最近一次发送（或前置拒绝）的请求下标；还没发过则为 null
   */
  function resultIndex(): number | null {
    return state.httpResultIndex;
  }

  return {
    rescan,
    openFile,
    syncWithSelection,
    toggleCollapse,
    toggleExpand,
    setRequestBodyOpen,
    setMode,
    ensureEditable: ensureEditableBuffer,
    markDirty,
    runMarkers,
    handleFormChange,
    commit,
    handlePromptChange,
    promptValue,
    send,
    resultIndex,
    resetForProject,
    invalidateScan,
    isDirty,
    discardChanges,
  };
}
