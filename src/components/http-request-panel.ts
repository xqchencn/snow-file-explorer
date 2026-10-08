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
import type { HttpParsedFile, HttpParsedRequest, HttpQueryParameter } from "../services/http-request-parser.ts";
import { splitUrlQuery, buildUrlWithQuery } from "../services/http-request-parser.ts";
import type { HttpEnvironmentSummary } from "../services/http-env.ts";
import { NO_ENVIRONMENT_NAME } from "../services/http-env.ts";
import type { HttpFormValues } from "../services/http-serialize.ts";
import type { HttpRunResult } from "../services/http-runner.ts";
import { missingVariableNames } from "../services/http-variables.ts";
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
  /**
   * 环境概况（当前环境名、可切的环境、各段的变量与来源文件）。
   * @description 由控制器给，组件自己不读盘：环境表和 `.env` 都在工作区的那几个固定位置上，
   *   组件手里只有请求文件的解析结果，拼不出这张表。
   */
  environment: HttpEnvironmentSummary;
  /** 切换环境回调 (name)；缺省时下拉禁用（例如宿主没给环境通道）。 */
  onEnvironmentChange?: (name: string) => void;
  /**
   * 打开「环境」弹窗：整张表（哪几段、各自哪些变量、加段、删段、保存）都在那一个弹窗里管。
   * 缺省时不出现「修改」那颗钮。
   * @description 弹窗要摊开什么都由装配层现读：段名查重、私密表盖住了哪些项，组件手里都没有。
   *   没有弹窗就没有能一次改完一张表的地方，而在面板里凭空摊开一堆输入框会连带重绘、
   *   把用户正敲到一半的那一格销毁。
   */
  onManageEnvironments?: () => Promise<void>;
  /**
   * 文件变量（`@name = value`）那一排此刻是否收起；省略按收起算。
   * @description 默认收起：变量一多，首屏全被这排读就好的胶囊占掉。折叠钮摆在环境那一行的右侧。
   *   没给开合通道（`onToggleVariables`）时没有折叠入口，这一排就一直列着——这里只用得上这一个开关。
   */
  variablesCollapsed?: boolean;
  /** 开合文件变量那一排；缺省时不出现那颗折叠钮（点了没用的控件不摆）。 */
  onToggleVariables?: () => void;
  /** 本地化翻译函数。 */
  t: TranslateFn;
};

/**
 * 提示变量里要掩码输入的变量名：写死的九个拼法（password / passwd / pass 各三种大小写）。
 * @description 判定是整名精确匹配，所以每个拼法都得单独列进来，少一个就漏一个。
 *   用固定名单而不是「这个名字像不像密码」的猜测：名单内一律掩码、名单外照常明文，
 *   哪些输入会被藏起来是用户能提前预期的。
 */
const MASKED_PROMPT_NAMES: ReadonlySet<string> = new Set([
  "password",
  "Password",
  "PASSWORD",
  "passwd",
  "Passwd",
  "PASSWD",
  "pass",
  "Pass",
  "PASS",
]);

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

/** 渲染折叠摘要：方法 + 地址，等宽展示。 */
function buildCardSummary(form: HttpFormValues): HTMLElement {
  return el("span", "sfe-http-card-summary", `${form.method} ${form.url}`.trim());
}

/**
 * 渲染一条请求的参数表（`?` 之后的查询串）。
 * @param card 所属卡片（collectForm 要从这里取各字段现值）
 * @param urlInput 地址输入框；参数表改的就是它 `?` 之后的那一段
 * @param headerRows 头部行清单（emit 时一起收集）
 * @returns 参数区容器，另带回一个「按地址现值重画参数行」的函数
 * @description 地址与参数表不是两份数据：参数表只是地址 `?` 那一段的另一种编辑面。
 *   每次改动都从**地址框的现值**取 `?` 之前的部分再拼回去，所以在地址框里改了路径
 *   不会把改动丢掉；反过来，在地址框里直接改查询串时由调用方重画参数行。
 *   改参数时**不重画参数行**：那会销毁用户正在敲的那一格。
 */
function renderParamsSection(
  card: HTMLElement,
  urlInput: HTMLInputElement,
  headerRows: HTMLElement[],
  opts: HttpRequestPanelOptions,
  index: number
): { wrap: HTMLElement; redraw: (params: readonly HttpQueryParameter[]) => void } {
  const wrap = el("div", "sfe-http-params");
  wrap.appendChild(el("div", "sfe-http-section-title", opts.t("http.params", "地址参数")));
  const rowsWrap = el("div", "sfe-http-param-rows");
  const paramRows: HTMLElement[] = [];

  const collect = (): HttpQueryParameter[] =>
    paramRows.map((row) => ({
      name: row.querySelector<HTMLInputElement>(".sfe-http-param-name")?.value || "",
      value: row.querySelector<HTMLInputElement>(".sfe-http-param-value")?.value || "",
    }));

  const apply = () => {
    const { base } = splitUrlQuery(urlInput.value);
    urlInput.value = buildUrlWithQuery(base, collect());
    opts.onFormChange(index, collectForm(card, headerRows));
  };

  const makeRow = (param: HttpQueryParameter): HTMLElement => {
    const row = el("div", "sfe-http-param-row");
    const name = el("input", "sfe-http-param-name");
    name.type = "text";
    name.spellcheck = false;
    name.value = param.name;
    name.placeholder = opts.t("http.paramName", "参数名");
    const value = el("input", "sfe-http-param-value");
    value.type = "text";
    value.spellcheck = false;
    value.value = param.value;
    value.placeholder = opts.t("http.paramValue", "值");
    const remove = el("button", "sfe-http-param-remove");
    remove.type = "button";
    remove.title = opts.t("http.removeParam", "删除这个参数");
    remove.setAttribute("aria-label", remove.title);
    remove.appendChild(createActionIcon("minus", 13));
    for (const input of [name, value]) input.addEventListener("input", apply);
    remove.addEventListener("click", () => {
      row.remove();
      const at = paramRows.indexOf(row);
      if (at >= 0) paramRows.splice(at, 1);
      apply();
    });
    row.appendChild(name);
    row.appendChild(value);
    row.appendChild(remove);
    return row;
  };

  const redraw = (params: readonly HttpQueryParameter[]): void => {
    paramRows.length = 0;
    rowsWrap.replaceChildren();
    for (const param of params) {
      const row = makeRow(param);
      paramRows.push(row);
      rowsWrap.appendChild(row);
    }
  };
  redraw(splitUrlQuery(urlInput.value).params);

  const add = el("button", "sfe-http-param-add");
  add.type = "button";
  add.appendChild(createActionIcon("plus", 12));
  add.appendChild(el("span", null, opts.t("http.addParam", "添加参数")));
  add.addEventListener("click", () => {
    const row = makeRow({ name: "", value: "" });
    paramRows.push(row);
    rowsWrap.appendChild(row);
    row.querySelector<HTMLInputElement>(".sfe-http-param-name")?.focus();
    apply();
  });
  wrap.appendChild(rowsWrap);
  wrap.appendChild(add);
  return { wrap, redraw };
}



/**
 * 「修改 / 添加环境」那颗按钮：整张环境表都在它打开的弹窗里管（加段、改名以外的编辑、删段、加行、保存）。
 * @param opts 面板数据
 * @returns 按钮节点；没有这条通道时为 null（点了没用的控件不摆是这仓的规矩）
 * @description 项目里一份环境表都没有时它叫「添加环境」：那时没有东西可改，词要跟用户能做的事对上；
 *   建出第一份表之后这颗钮就变回「修改」。
 */
function renderEnvironmentModify(opts: HttpRequestPanelOptions): HTMLElement | null {
  if (typeof opts.onManageEnvironments !== "function") return null;
  const { environment, t } = opts;
  // 「没有环境表」看三处：没有表文件、没有可切环境、连 $shared 都没有。
  const empty = !environment.files.length && !environment.names.length && !environment.hasShared;
  const button = el("button", "sfe-http-env-modify");
  button.type = "button";
  button.appendChild(createActionIcon(empty ? "plus" : "pencil", 12));
  button.appendChild(el("span", null, empty ? t("http.envAddSection", "添加环境") : t("http.envModify", "修改")));
  button.addEventListener("click", () => {
    // 弹窗、现读、落盘都在装配层那一条路上：这里只负责把它叫出来。
    void opts.onManageEnvironments!();
  });
  return button;
}

/**
 * 文件变量那一排的折叠钮。
 * @param opts 面板数据
 * @returns 按钮节点；这篇文件没有文件变量、或没给开合通道时为 null
 * @description 钮上直接报「几项」，所以收起时不列也不觉得少了什么；点开才逐条列出来。
 *   它挂在环境那一行的最右侧——那一行本来就是「这篇文件的取值背景」，两件事同一个位置。
 */
function renderVariablesFold(opts: HttpRequestPanelOptions): HTMLElement | null {
  const count = opts.file.variables.length;
  if (!count || typeof opts.onToggleVariables !== "function") return null;
  const { t } = opts;
  const collapsed = opts.variablesCollapsed !== false;
  const label = t("http.fileVariables", "文件变量 {{count}}", { count });
  const button = el("button", "sfe-http-env-fold");
  button.type = "button";
  button.appendChild(createActionIcon(collapsed ? "chevronRight" : "chevronDown", 12));
  button.appendChild(el("span", null, label));
  button.title = `${collapsed ? t("http.expand", "展开") : t("http.collapse", "折叠")}: ${label}`;
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  button.addEventListener("click", () => {
    if (typeof opts.onToggleVariables === "function") opts.onToggleVariables();
  });
  return button;
}

/**
 * 渲染环境区：一行「环境 [下拉] [修改] [文件变量 ▸]」，其下只留说明性的行（覆盖情况、`.env` 计数、解析问题）。
 * @param opts 面板数据（含环境概况、切换环境与打开弹窗的通道）
 * @param fold 文件变量那一排的折叠钮；给的时候钉在这一行最右侧（这一行没出现时由调用方另找位置）
 * @returns 环境区节点；一行内容都凑不出来时为 null（调用方不摆空块）
 * @description 入口常驻：环境是项目级的配置，没用到引用的普通文件也得有地方创建第一份环境表——
 *   入口只在「用到变量」时才出现的话，一篇干净文件永远开不了这张表。没得切仍不摆死下拉，
 *   缺值引导也只在该缺的时候出现；弹窗通道没给时只少那颗钮，叙述照常（表读坏了照样要说）。
 * @description 区外不再逐段摆清单：哪一段带哪些键、谁盖住了谁，都在弹窗里对着改；
 *   常驻区只留「现在用的是哪一段」与一颗改得动的钮。
 */
function renderEnvironmentBar(opts: HttpRequestPanelOptions, fold: HTMLElement | null): HTMLElement | null {
  const { environment, t } = opts;
  const names = environment.names;
  const references = opts.file.requests.flatMap((request) => request.variableRefs);
  const bar = el("div", "sfe-http-env");
  // 缺变量的判断与卡片那条共用一份逻辑：两处各算一次会给出两个答案。
  const defined = new Set<string>([
    ...environment.variables.keys(),
    ...opts.file.variables.map((variable) => variable.name),
    ...opts.file.requests.flatMap((request) => request.prompts.map((prompt) => prompt.name)),
  ]);
  const needed = missingVariableNames(references, defined);
  // 一份环境表都没有、引用又取不到值：先把「为什么要点这颗钮」说清，再让钮出场。
  if (!environment.files.length && !names.length && !environment.hasShared && needed.length) {
    bar.appendChild(
      el("div", "sfe-http-env-hint", t("http.envMissing", "{{names}} 还没有取值处，创建环境后在这里填值", { names: needed.join(", ") }))
    );
  }

  const line = el("div", "sfe-http-env-line");
  // 一个可选的环境都没有就不摆下拉：只剩「不选环境」一项的选择器是颗点不出名堂的死控件。
  // 这一段环境还是得露面（它的值此刻正在被用），只是没得切。
  if (names.length) {
    const picker = el("select", "sfe-http-env-select");
    const none = el("option", null, t("http.envNone", "不选环境"));
    none.value = NO_ENVIRONMENT_NAME;
    if (environment.active === NO_ENVIRONMENT_NAME) none.selected = true;
    picker.appendChild(none);
    for (const name of names) {
      const option = el("option", null, name);
      option.value = name;
      if (name === environment.active) option.selected = true;
      picker.appendChild(option);
    }
    picker.disabled = typeof opts.onEnvironmentChange !== "function";
    picker.title = t("http.envSwitch", "切换环境");
    picker.setAttribute("aria-label", picker.title);
    picker.addEventListener("change", () => {
      if (typeof opts.onEnvironmentChange === "function") opts.onEnvironmentChange(picker.value);
    });
    const label = el("label", "sfe-http-env-label", t("http.environment", "环境"));
    label.setAttribute("for", "sfe-http-env-select");
    picker.id = "sfe-http-env-select";
    line.appendChild(label);
    line.appendChild(picker);
  }
  if (environment.hasShared) {
    const chip = el("span", "sfe-http-env-chip", "$shared");
    chip.title = t("http.sharedReserved", "$shared 是保留名，里面的变量对所有环境可见");
    line.appendChild(chip);
  }
  const modify = renderEnvironmentModify(opts);
  if (modify) line.appendChild(modify);
  // 文件变量的折叠钮钉在这一行最右侧：常驻区就这一行讲取值背景，两件事不该占两处。
  // 但它不蹭空行者的名分——这行一件环境的事都没有时（没通道没环境），它回调用方给自己摆的那一行。
  if (fold && line.childNodes.length) line.appendChild(fold);
  if (line.childNodes.length) bar.appendChild(line);
  if (environment.overriddenShared.length) {
    bar.appendChild(
      el(
        "div",
        "sfe-http-env-note",
        t("http.envOverridesShared", "当前环境覆盖了共享环境的 {{count}} 项：{{names}}", {
          count: environment.overriddenShared.length,
          names: environment.overriddenShared.join(", "),
        })
      )
    );
  }
  if (environment.dotenvPath) {
    bar.appendChild(el("div", "sfe-http-env-note", `.env · ${environment.dotenvCount}`));
  }
  for (const issue of environment.issues) {
    bar.appendChild(
      el(
        "div",
        "sfe-http-warning",
        issue.code === "invalidJson"
          ? t("http.envInvalidJson", "{{file}} 不是合法的 JSON，这份环境表没有生效", { file: issue.file })
          : issue.code === "notObject"
            ? t("http.envBadShape", "{{file}} 的形状不对：环境表要写成 { \u0022环境名\u0022: { \u0022变量名\u0022: \u0022值\u0022 } }", {
                file: issue.file,
              })
            : issue.code === "skippedValue"
              ? t("http.envSkippedValue", "{{file}} 里 {{name}} 的值不是文字/数字/真假，这一项不生效", {
                  file: issue.file,
                  name: issue.name || "",
                })
              : t("http.envReadFailed", "{{file}} 没能读取", { file: issue.file })
      )
    );
  }
  // 一行都凑不出来（没通道、没环境、没折叠钮、没引导也没问题可报）：整块不摆，别留一个空壳。
  return bar.childNodes.length ? bar : null;
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
  } else if (request.curl) {
    // curl 一节的只读投影：发送照做（把还原出来的方法 / 地址 / 头部 / 正文发出去是真效果），
    // 但不给可编辑控件——GUI 改动写不回 curl 命令（http-serialize 会跳过这类块），
    // 摆一堆改了没用的框等于骗人。要改就回文本态改那行 curl。
    const summary = el("div", "sfe-http-line");
    summary.appendChild(el("span", "sfe-http-builder-summary", `${form.method} ${form.url}`.trim()));
    summary.appendChild(send);
    builder.appendChild(summary);
    builderBody.appendChild(
      el("div", "sfe-http-hint", t("http.curlReadOnly", "这条是从 curl 命令还原出来的，改动请回文本态改那条命令"))
    );
    if (form.headers.length) {
      const list = el("div", "sfe-http-headers");
      list.appendChild(el("div", "sfe-http-section-title", t("http.headers", "请求头")));
      for (const header of form.headers) {
        list.appendChild(el("div", "sfe-http-header-static", `${header.name}: ${String(header.value ?? "")}`));
      }
      builderBody.appendChild(list);
    }
    const bodyText = String(form.body || "");
    const bodyList = el("div", "sfe-http-body-wrap");
    const bodyHost = el("div", "sfe-http-body-host");
    if (bodyText.trim()) renderJsonFoldView(bodyHost, bodyText, t, {});
    else bodyHost.appendChild(el("div", "sfe-http-body-empty", t("http.bodyEmpty", "没有请求体")));
    bodyList.appendChild(bodyHost);
    builderBody.appendChild(bodyList);
    builder.appendChild(builderBody);
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
    /** 参数区在头部之前建好；地址框被直接改动时按新地址重画参数行。 */
    let redrawParams: ((params: readonly HttpQueryParameter[]) => void) | null = null;
    url.addEventListener("input", () => {
      opts.onFormChange(index, collectForm(card, headerRows));
      if (redrawParams) redrawParams(splitUrlQuery(url.value).params);
    });
    line.appendChild(method);
    line.appendChild(url);
    // 发送按钮收进地址行，形成「方法 / 地址 / 发送」一体的 Omnibar。
    line.appendChild(send);
    builder.appendChild(line);
    if (!form.url.trim()) {
      // 地址空着必定发不出去（会被前置拒绝），先说清楚，别让用户点了才看到错误。
      builderBody.appendChild(el("div", "sfe-http-hint", t("http.emptyAddress", "这条请求还没填地址，发送会被拦下")));
    }

    /** 头部行清单：地址框与参数表都要在改动时把整张卡片现值收回去，故先于参数区声明。 */
    const headerRows: HTMLElement[] = [];
    const params = renderParamsSection(card, url, headerRows, opts, index);
    redrawParams = params.redraw;
    builderBody.appendChild(params.wrap);

    const headersWrap = el("div", "sfe-http-headers");
    const headersTitle = el("div", "sfe-http-section-title", t("http.headers", "请求头"));
    const addHeader = el("button", "sfe-http-header-add");
    addHeader.type = "button";
    addHeader.appendChild(createActionIcon("plus", 12));
    addHeader.appendChild(el("span", null, t("http.addHeader", "添加头部")));
    headersWrap.appendChild(headersTitle);
    const rowsWrap = el("div", "sfe-http-header-rows");
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
        // 密码一族变量名一律掩码输入：只看那张固定名单，不靠猜哪些名字算敏感。
        input.type = MASKED_PROMPT_NAMES.has(prompt.name) ? "password" : "text";
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
    // 环境表里的键同理——选了环境之后 `{{host}}` 是有值的，不能再报「本文件里没有定义」。
    const defined = new Set<string>([
      ...request.prompts.map((prompt) => prompt.name),
      ...opts.environment.variables.keys(),
      ...file.variables.map((variable) => variable.name),
    ]);
    const missing = missingVariableNames(request.variableRefs, defined);
    if (missing.length) {
      builderBody.appendChild(
        el(
          "div",
          "sfe-http-warning",
          opts.environment.files.length
            ? t("http.missingVariablesInEnv", "这些变量在本文件和当前环境里都没有定义：{{names}}", { names: missing.join(", ") })
            : t("http.missingVariables", "这些变量在本文件里没有定义：{{names}}", { names: missing.join(", ") })
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
function requestMetadataChips(request: HttpParsedRequest, opts: HttpRequestPanelOptions): HTMLElement[] {
  const out: HTMLElement[] = [];
  const add = (text: string, tone: string, hint = "") => {
    const chip = el("span", "sfe-http-chip " + tone, text);
    if (hint) chip.title = hint;
    out.push(chip);
  };
  if (request.note) add(request.note, "note");
  if (request.noRedirect) add(opts.t("http.chipNoRedirect", "不跟随重定向"), "warn");
  if (request.noCookieJar) add(opts.t("http.chipNoCookieJar", "不存 cookie"), "warn");
  // 响应脚本不执行、响应不落盘：这两段都不在本插件的执行范围，既不跑也不写文件。
  // 卡片上要点名「这一段被忽略了」——静默吞掉用户写在这一节里的内容，比报个错更难查。
  if (request.responseHandler) {
    add(opts.t("http.chipHandler", "响应脚本不执行"), "unknown", opts.t("http.handlerHint", "这段响应脚本不会被执行，原文仍留在文件里"));
  }
  if (request.outputRedirect) {
    add(
      opts.t("http.chipOutput", "响应不落盘"),
      "unknown",
      opts.t("http.outputHint", "响应不会写进文件，这一行原样留在请求里")
    );
  }
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
  // 文件变量的折叠钮先建好：环境那一行出现就挂在它右侧，没出现就自己占一行（不然收起后没地方展开）。
  const fold = renderVariablesFold(opts);
  // 环境条放最前面：它决定 `{{host}}` 这类变量今天是从哪一套值里取的。
  const envBar = renderEnvironmentBar(opts, fold);
  if (envBar) wrap.appendChild(envBar);
  else if (fold) {
    const head = el("div", "sfe-http-variables-head");
    head.appendChild(fold);
    wrap.appendChild(head);
  }
  // 文件变量条：横向换行排布，默认收起（只读展示，改值仍回文本态，避免同一份定义两处可编）。
  // 没给开合通道时没有折叠入口，就照原样一直列着。
  if (opts.file.variables.length && (!fold || opts.variablesCollapsed === false)) {
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
        opts.t("http.skippedResponses", "{{count}} 段粘贴进来的响应内容不会发送", {
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
