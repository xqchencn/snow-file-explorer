/**
 * HTTP 请求 GUI 面板 (src/components/http-request-panel.ts)
 * @description 「HTTP 请求」主视图右侧的工作台（对标 Postman）：
 *   顶部是请求列表（折叠的请求各占一行），一次聚焦一条请求——聚焦的卡片撑满面板高度，
 *   内部拆成「请求构建区 / 响应区」两段：构建区 = 固定的 Omnibar（方法 / 地址 / 发送）+
 *   可独立滚动的配置区（请求头 / 提示变量 / 请求体）；响应区独立滚动。
 *   与「文本」态（这篇文件本来的代码查看器）互为切换，两者看的是同一个文件、同一份正文。
 * @description 键入只把值交给装配层（opts.onFormChange），不在这里触发重绘：
 *   重绘会销毁输入框、打断光标与选区，与文件树/Git 视图同一条规矩。
 *   焦点真的离开某张卡片时才交给装配层写盘，之后整面板重建（那时输入框本来就已失焦）。
 *   改动与保存结果都在未保存条上就地反映，不为一个状态翻整屏卡片。
 */

import type { TranslateFn } from "../types/panel-state.ts";
import type { ViewerChromeState } from "./code-viewer.ts";
import type { HttpParsedFile } from "../services/http-request-parser.ts";
import type { HttpFormValues } from "../services/http-serialize.ts";
import type { HttpRunResult } from "../services/http-runner.ts";
import { isBuiltinVariableReference } from "../services/http-variables.ts";
import { el } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { renderHttpResult } from "./http-result-view.ts";
import { renderJsonFoldView, renderJsonBodyEditor } from "./json-view.ts";

/** 方法下拉的候选：宿主代发通道实际收的那几个。 */
const SENDABLE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** 渲染 GUI 面板需要的数据与回调。 */
export type HttpRequestPanelOptions = {
  /** 当前文件的解析结果。 */
  file: HttpParsedFile;
  /** 取某条请求的当前表单值（装配层持有，含用户已改未存的值）。 */
  getForm: (index: number) => HttpFormValues;
  /** 每条请求最近一次的执行结果；键为请求下标。 */
  responses: ReadonlyMap<number, HttpRunResult>;
  /** 正在发送的请求下标；null 表示空闲。 */
  runningIndex: number | null;
  /** 展开的请求键（`r<下标>`）；不在里面即折叠态。默认全折叠。 */
  expanded: ReadonlySet<string>;
  /**
   * 「构建区已收起」的请求下标集合。
   * @description 构建区默认摊开供编辑；发送完成后该条被登记进来（收起，只留结果），
   *   用户点「展开请求区」则移出。装配层持有它，故折叠卡片再展开、切来切去，
   *   看到的都是该请求此刻该有的默认态，不会被别的请求带偏。
   */
  collapsedBodies: ReadonlySet<number>;
  /** 折叠/展开某条请求（键由装配层持有，与文本态共用一套）。 */
  onToggle: (key: string) => void;
  /** 开合某条请求的构建区（请求头 / 提示变量 / 请求体）；open=true 摊开、false 收起。 */
  onToggleBody: (index: number, open: boolean) => void;
  /** 缓冲里是否有未写盘的改动（GUI 与文本态共用同一份正文，脏一次就是整份脏）。 */
  dirty: boolean;
  /** 保存回调；缺省时不出现保存条。 */
  onSave?: () => void;
  /** 放弃改动、重读磁盘原文回调；缺省时不出现放弃按钮。 */
  onReload?: () => void;
  /** 表单值变化回调 (index, values)；只登记，不重绘。 */
  onFormChange: (index: number, values: HttpFormValues) => void;
  /** 焦点离开整张卡片时提交（写盘）；卡片内字段间跳转不触发。 */
  onCommit: (index: number) => void;
  /** 点击发送回调 (index)。 */
  onSend: (index: number) => void;
  /** 提示变量填值变化回调 (requestIndex, name, value)；装配层存进变量作用域。 */
  onPromptChange: (index: number, name: string, value: string) => void;
  /** 取提示变量已填的值 (requestIndex, name)；未填为空串。 */
  getPromptValue: (index: number, name: string) => string;
  /** 本地化翻译函数。 */
  t: TranslateFn;
};

/** 提交当前卡片的全部可编辑字段（输入框与头部表都从 DOM 现值取，避免各自为政）。 */
function collectForm(card: HTMLElement, headerRows: HTMLElement[]): HttpFormValues {
  const method = card.querySelector<HTMLSelectElement>(".sfe-http-method")?.value || "GET";
  const url = card.querySelector<HTMLInputElement>(".sfe-http-url")?.value || "";
  const body = card.querySelector<HTMLTextAreaElement>(".sfe-http-body")?.value ?? "";
  const headers: Array<{ name: string; value: string }> = [];
  for (const row of headerRows) {
    const name = row.querySelector<HTMLInputElement>(".sfe-http-header-name")?.value || "";
    const value = row.querySelector<HTMLInputElement>(".sfe-http-header-value")?.value || "";
    if (!name.trim()) continue;
    headers.push({ name, value });
  }
  return { method, url, headers, body };
}

/** 渲染一行头部（名 / 值 / 删除）。 */
function renderHeaderRow(
  header: { name: string; value: string },
  card: HTMLElement,
  headerRows: HTMLElement[],
  opts: HttpRequestPanelOptions,
  index: number
): HTMLElement {
  const row = el("div", "sfe-http-header-row");
  const name = el("input", "sfe-http-header-name");
  name.type = "text";
  name.spellcheck = false;
  name.value = header.name;
  name.placeholder = opts.t("http.headerName", "头部名");
  const value = el("input", "sfe-http-header-value");
  value.type = "text";
  value.spellcheck = false;
  value.value = header.value;
  value.placeholder = opts.t("http.headerValue", "值");
  const remove = el("button", "sfe-http-header-remove");
  remove.type = "button";
  remove.title = opts.t("http.removeHeader", "删除这条头部");
  remove.setAttribute("aria-label", remove.title);
  remove.appendChild(createActionIcon("minus", 13));
  const emit = () => opts.onFormChange(index, collectForm(card, headerRows));
  for (const input of [name, value]) input.addEventListener("input", emit);
  remove.addEventListener("click", () => {
    row.remove();
    const at = headerRows.indexOf(row);
    if (at >= 0) headerRows.splice(at, 1);
    emit();
  });
  row.appendChild(name);
  row.appendChild(value);
  row.appendChild(remove);
  return row;
}

/**
 * 折叠态摘要：方法 + 地址，等宽展示。
 * @param form 该请求当前表单值
 * @returns 摘要节点
 */
function buildCardSummary(form: HttpFormValues): HTMLElement {
  return el("span", "sfe-http-card-summary", `${form.method} ${form.url}`.trim());
}

/** 渲染一条请求的卡片。 */
function renderRequestCard(index: number, opts: HttpRequestPanelOptions, bodyOpen: boolean): HTMLElement {
  const { file, t } = opts;
  const request = file.requests[index];
  let form = opts.getForm(index);
  const key = `r${index}`;
  const expanded = opts.expanded.has(key);
  // 展开态（聚焦）的卡片撑满主区、内部两区分栏；折叠态只是列表里的一行。
  const card = el("div", "sfe-http-card" + (expanded ? " expanded" : ""));
  card.dataset.requestIndex = String(index);

  const head = el("div", "sfe-http-card-head");
  const fold = el("button", "sfe-http-card-fold");
  fold.type = "button";
  fold.setAttribute("aria-expanded", expanded ? "true" : "false");
  // 折叠按钮同时是这张卡片的标题位：可读名字带上请求名，读屏用户才知道展开的是哪一条。
  const requestLabel = request.title || request.name || request.url || t("http.unnamed", "未命名请求");
  fold.title = `${expanded ? t("http.collapse", "折叠") : t("http.expand", "展开")}: ${requestLabel}`;
  fold.setAttribute("aria-label", fold.title);
  fold.appendChild(createActionIcon(expanded ? "chevronDown" : "chevronRight", 13));
  fold.appendChild(el("span", "sfe-http-card-index", String(index + 1)));
  fold.appendChild(el("span", "sfe-http-card-name", requestLabel));
  // 折叠态只有这一行可看：方法做成语义色徽章 + 等宽地址，一眼认出是哪条。
  if (!expanded) fold.appendChild(buildCardSummary(form));
  fold.addEventListener("click", () => opts.onToggle(key));
  head.appendChild(fold);
  for (const chip of requestMetadataChips(request, opts)) head.appendChild(chip);
  const send = el("button", "sfe-http-send");
  send.type = "button";
  send.disabled = opts.runningIndex !== null;
  send.appendChild(createActionIcon(opts.runningIndex === index ? "rerun" : "play", 13));
  send.appendChild(
    el(
      "span",
      "sfe-http-send-label",
      opts.runningIndex === index ? t("http.sending", "发送中…") : t("http.send", "发送")
    )
  );
  send.title = `${t("http.send", "发送")} (Ctrl+Enter)`;
  send.addEventListener("click", () => opts.onSend(index));
  // 折叠态：发送按钮落在标题行右侧，收起也能直接发。
  // 展开态：按钮改挂到地址行右侧（Omnibar：方法 / 地址 / 发送 同一行），
  //   免得用户改完地址还要把鼠标移回上一行右上角去点。
  if (!expanded) head.appendChild(send);
  card.appendChild(head);
  card.addEventListener("focusout", (event: FocusEvent) => {
    // 卡片内部换字段（含 Tab）不该写盘；只有焦点真的离开这张卡片才提交。
    if (card.contains(event.relatedTarget as Node | null)) return;
    opts.onCommit(index);
  });
  // Ctrl/Cmd+Enter 发送：所有主流 HTTP 客户端的肌肉记忆，不必把手从键盘挪到鼠标。
  card.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    opts.onSend(index);
  });
  if (!expanded) return card;

  // 展开态 = 聚焦这一条：上方「请求构建区」（Omnibar 固定、配置区可整体收起），
  // 下方「响应区」。构建区默认折叠（bodyOpen=false）：发送之后只留结果，视线不被请求头/请求体占住；
  // 点开卡片编辑时（bodyOpen=true）才摊开配置区。
  const builder = el("div", "sfe-http-builder");
  const builderBody = el("div", "sfe-http-builder-body");
  const line = el("div", "sfe-http-line");
  // 折叠态：Omnibar 变成「只读摘要 + 一个展开按钮」，点一下才把配置区摊开。
  if (!bodyOpen) {
    const toggle = el("button", "sfe-http-builder-toggle");
    toggle.type = "button";
    toggle.title = t("http.expand", "展开");
    toggle.setAttribute("aria-label", t("http.expand", "展开"));
    toggle.setAttribute("aria-expanded", "false");
    toggle.appendChild(createActionIcon("chevronRight", 13));
    const summary = el("span", "sfe-http-builder-summary", `${form.method} ${form.url}`.trim());
    toggle.appendChild(summary);
    // 只摊开配置区，不收起卡片：这是「展开请求区」，不是「折叠这张卡片」。
    toggle.addEventListener("click", () => opts.onToggleBody(index, true));
    line.appendChild(toggle);
    // 构建区收起时，发送按钮仍留在这一行，改完地址不必回头找。
    line.appendChild(send);
    builder.appendChild(line);
  } else {
    const method = el("select", "sfe-http-method");
    const candidates = SENDABLE_METHODS.includes(form.method) ? SENDABLE_METHODS : [form.method, ...SENDABLE_METHODS];
    for (const name of candidates) {
      const option = el("option", null, name);
      option.value = name;
      if (name === form.method) option.selected = true;
      if (!SENDABLE_METHODS.includes(name)) option.title = t("http.methodUnsupported", "暂不支持用这个方法发送");
      method.appendChild(option);
    }
    method.addEventListener("change", () => opts.onFormChange(index, collectForm(card, headerRows)));
    const url = el("input", "sfe-http-url");
    url.type = "text";
    url.spellcheck = false;
    url.value = form.url;
    url.placeholder = t("http.urlPlaceholder", "https:// 或 {{变量}}");
    url.addEventListener("input", () => opts.onFormChange(index, collectForm(card, headerRows)));
    line.appendChild(method);
    line.appendChild(url);
    // 发送按钮收进地址行，形成「方法 / 地址 / 发送」一体的 Omnibar。
    line.appendChild(send);
    builder.appendChild(line);
    if (!form.url.trim()) {
      // 地址空着必定发不出去（会被前置拒绝），先说清楚，别让用户点了才看到错误。
      builderBody.appendChild(el("div", "sfe-http-hint", t("http.emptyAddress", "这条请求还没填地址，发送会被拦下")));
    }

    const headersWrap = el("div", "sfe-http-headers");
    const headersTitle = el("div", "sfe-http-section-title", t("http.headers", "请求头"));
    const addHeader = el("button", "sfe-http-header-add");
    addHeader.type = "button";
    addHeader.appendChild(createActionIcon("plus", 12));
    addHeader.appendChild(el("span", null, t("http.addHeader", "添加头部")));
    headersWrap.appendChild(headersTitle);
    const rowsWrap = el("div", "sfe-http-header-rows");
    const headerRows: HTMLElement[] = [];
    for (const header of form.headers) {
      const row = renderHeaderRow(header, card, headerRows, opts, index);
      headerRows.push(row);
      rowsWrap.appendChild(row);
    }
    addHeader.addEventListener("click", () => {
      const row = renderHeaderRow({ name: "", value: "" }, card, headerRows, opts, index);
      headerRows.push(row);
      rowsWrap.appendChild(row);
      row.querySelector<HTMLInputElement>(".sfe-http-header-name")?.focus();
    });
    headersWrap.appendChild(rowsWrap);
    headersWrap.appendChild(addHeader);
    builderBody.appendChild(headersWrap);

    if (request.prompts.length) {
      const prompts = el("div", "sfe-http-prompts");
      prompts.appendChild(el("div", "sfe-http-section-title", t("http.promptVariables", "发送前要填的值")));
      for (const prompt of request.prompts) {
        const row = el("div", "sfe-http-prompt-row");
        const label = el("label", "sfe-http-prompt-label", prompt.description || prompt.name);
        const input = el("input", "sfe-http-prompt-input");
        input.type = "text";
        input.value = opts.getPromptValue(index, prompt.name);
        input.placeholder = prompt.name;
        input.addEventListener("input", () => opts.onPromptChange(index, prompt.name, input.value));
        label.setAttribute("for", `sfe-http-prompt-${index}-${prompt.name}`);
        input.id = `sfe-http-prompt-${index}-${prompt.name}`;
        row.appendChild(label);
        row.appendChild(input);
        prompts.appendChild(row);
      }
      builderBody.appendChild(prompts);
    }

    const bodyWrap = el("div", "sfe-http-body-wrap");
    // 请求体与响应正文一视同仁：JSON 时是「可整体折叠 + 内部每个 {} / [] 单独折叠」的着色视图，
    // 另给一个「编辑」按钮切到编辑态（着色高亮层 + 透明 textarea），不再把裸 textarea 摊在面板上。
    const bodyHost = el("div", "sfe-http-body-host");
    // 编辑态只在「本次渲染内」有效：切走/重绘即回到折叠视图，避免脏编辑态常驻。
    let editingBody = false;
    const renderBody = () => {
      bodyHost.replaceChildren();
      if (editingBody) {
        renderJsonBodyEditor(bodyHost, form.body || "", t, (value) => {
          form = { ...form, body: value };
          opts.onFormChange(index, collectForm(card, headerRows));
        });
        return;
      }
      if (String(form.body || "").trim()) {
        renderJsonFoldView(bodyHost, form.body || "", t, {
          onEdit: () => {
            editingBody = true;
            renderBody();
          },
        });
      } else {
        bodyHost.appendChild(el("div", "sfe-http-body-empty", t("http.bodyEmpty", "没有请求体")));
      }
    };
    renderBody();
    bodyWrap.appendChild(bodyHost);
    if (request.bodyFiles.length) {
      bodyWrap.appendChild(
        el(
          "div",
          "sfe-http-hint",
          t("http.bodyFileHint", "正文里的 < 文件引用会在发送时读进来（文本文件）")
        )
      );
    }
    builderBody.appendChild(bodyWrap);

    // 只提示「本文件该定义却没定义」的变量：系统变量、请求变量、`# @prompt` 声明的变量
    // 天生不在文件变量表里，一并算进去的话正常文件会常驻假警告。
    const refs = request.variableRefs.filter((ref) => !isBuiltinVariableReference(ref));
    const declaredPrompts = new Set(request.prompts.map((prompt) => prompt.name));
    const missing = refs.filter((ref) => {
      const name = ref.replace(/^%/, "");
      if (declaredPrompts.has(name)) return false;
      return !file.variables.some((variable) => variable.name === name);
    });
    if (missing.length) {
      builderBody.appendChild(
        el(
          "div",
          "sfe-http-warning",
          t("http.missingVariables", "这些变量在本文件里没有定义：{{names}}", { names: missing.join(", ") })
        )
      );
    }

    builder.appendChild(builderBody);
  }
  card.appendChild(builder);

  const response = el("div", "sfe-http-response");
  const result = opts.responses.get(index);
  if (result) {
    renderHttpResult(response, result, t);
  } else {
    response.appendChild(
      el("div", "sfe-http-empty", t("http.guiResultHint", "点发送，请求体与响应会显示在这里"))
    );
  }
  card.appendChild(response);
  return card;
}

/** 元数据 chips：note / no-redirect / no-cookie-jar / 未识别的键。 */
function requestMetadataChips(request: HttpParsedFile["requests"][number], opts: HttpRequestPanelOptions): HTMLElement[] {
  const out: HTMLElement[] = [];
  const add = (text: string, tone: string, hint = "") => {
    const chip = el("span", "sfe-http-chip " + tone, text);
    if (hint) chip.title = hint;
    out.push(chip);
  };
  if (request.note) add(request.note, "note");
  if (request.noRedirect) add(opts.t("http.chipNoRedirect", "不跟随重定向"), "warn");
  if (request.noCookieJar) add(opts.t("http.chipNoCookieJar", "不存 cookie"), "warn");
  // 未识别的 `# @key`：只画一个 chip 用户看不懂，补一句「这项不会生效」。
  for (const key of request.unknownMetadata) {
    add(`@${key}`, "unknown", opts.t("http.unknownMetadata", "这项指令没有被识别，不会生效"));
  }
  return out;
}

/**
 * 渲染 GUI 面板（请求卡片清单）。
 * @param parent 容器；每次调用整体重建（调用方保证不在用户键入中间调用）
 * @param opts 面板数据与回调
 */
export function renderHttpRequestPanel(parent: HTMLElement, opts: HttpRequestPanelOptions): void {
  // 重建前记下滚动位置：换文件、折叠、保存都会走到这里，视口不该跳回顶部。
  const previous = parent.firstElementChild as HTMLElement | null;
  const previousScroll = previous ? previous.scrollTop : 0;
  parent.replaceChildren();
  const wrap = el("div", "sfe-http-panel");
  // 文件变量条：横向换行排布（原来是每变量一行，变量一多首屏全被它占掉）。
  // 只读展示，改值仍回文本态，避免同一份定义两处可编。
  if (opts.file.variables.length) {
    const variableList = el("div", "sfe-http-variables");
    for (const variable of opts.file.variables) {
      variableList.appendChild(el("div", "sfe-http-variable", `@${variable.name} = ${variable.value}`));
    }
    wrap.appendChild(variableList);
  }
  // 解析器留了痕、但界面上不说的两种「写了却没生效」：说了才叫「做不到会说明」。
  for (const line of opts.file.braceStyleVariableLines) {
    wrap.appendChild(
      el(
        "div",
        "sfe-http-warning",
        opts.t("http.ignoredVariableDefinition", "第 {{line}} 行的变量定义写法不被识别，请改用 @name = value", {
          line: line + 1,
        })
      )
    );
  }
  if (opts.file.skippedResponseSections.length) {
    wrap.appendChild(
      el(
        "div",
        "sfe-http-warning",
        opts.t("http.skippedResponses", "已跳过 {{count}} 段粘贴进来的响应内容", {
          count: opts.file.skippedResponseSections.length,
        })
      )
    );
  }
  if (!opts.file.requests.length) {
    // 空态放最后：它描述的是「这文件没有请求」，压在变量条上面会看起来像在说变量条。
    wrap.appendChild(el("div", "sfe-http-empty", opts.t("http.noRequests", "这个文件里没有请求")));
  }

  // 未保存条常驻但默认收起：改动与保存结果都就地翻这一条，不重建卡片（重建会打断正在输入的框）。
  const bar = el("div", "sfe-http-dirty");
  const barLabel = el("span", "sfe-http-dirty-label", opts.t("http.unsaved", "有未保存的改动"));
  bar.appendChild(barLabel);
  let dirty = opts.dirty === true;
  let failure = "";
  const refreshBar = () => {
    bar.hidden = !dirty;
    barLabel.textContent = failure || opts.t("http.unsaved", "有未保存的改动");
  };
  refreshBar();
  if (typeof opts.onReload === "function") {
    const reload = el("button", "sfe-http-dirty-btn");
    reload.type = "button";
    reload.title = opts.t("http.discard", "放弃");
    reload.appendChild(createActionIcon("undo", 13));
    reload.appendChild(el("span", null, opts.t("http.discard", "放弃")));
    reload.addEventListener("click", () => {
      if (typeof opts.onReload === "function") opts.onReload();
    });
    bar.appendChild(reload);
  }
  if (typeof opts.onSave === "function") {
    const save = el("button", "sfe-http-dirty-btn primary");
    save.type = "button";
    save.title = opts.t("http.save", "保存");
    save.appendChild(createActionIcon("check", 13));
    save.appendChild(el("span", null, opts.t("http.save", "保存")));
    save.addEventListener("click", () => {
      if (typeof opts.onSave === "function") opts.onSave();
    });
    bar.appendChild(save);
  }

  const session: HttpRequestPanelOptions = {
    ...opts,
    onFormChange: (index, values) => {
      dirty = true;
      failure = "";
      refreshBar();
      opts.onFormChange(index, values);
    },
  };
  // 保存通道（preview-controller）就地同步这一条，不为一个状态翻整屏卡片。
  parent.__sfeViewerChromeSync = (chrome: ViewerChromeState) => {
    if (chrome.saveState === "saved") {
      dirty = false;
      failure = "";
    } else if (chrome.saveState === "failed") {
      dirty = true;
      failure = chrome.saveMessage || opts.t("action.saveFailed", "保存失败");
    } else if (chrome.saveState === "saving") {
      failure = opts.t("action.saving", "保存中…");
    }
    refreshBar();
  };

  for (const [index] of opts.file.requests.entries()) {
    // 构建区默认摊开（可直接编辑）；发送完成后该条被登记进「已收起」，只留结果。
    const bodyOpen = !opts.collapsedBodies.has(index);
    wrap.appendChild(renderRequestCard(index, session, bodyOpen));
  }
  wrap.appendChild(bar);
  parent.appendChild(wrap);
  if (previousScroll) wrap.scrollTop = previousScroll;
}
