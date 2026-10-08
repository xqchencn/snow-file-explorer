/**
 * HTTP 请求文件视图组件 (src/components/http-view.ts)
 * @description 左侧入口栏「HTTP 请求」主视图的列表面板：把整仓扫描到的 `.http` / `.rest`
 *   文件按所在目录排成可折叠的树，单击文件即在右侧查看器打开。
 *   纯 DOM 渲染，数据与回调由装配层注入，与 git-view 同一套结构复用约定：
 *   列表滚动容器本身常驻，刷新只重建其内部行，滚动位置不丢。
 */

import type { HttpRestFile } from "../services/http-file-scan.ts";
import type { TranslateFn } from "../types/panel-state.ts";
import { el } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { createFileIconNode } from "../icons/file-icons.ts";

/** 树节点：目录节点带 children，文件叶子节点带 file。 */
export type HttpTreeNode = {
  /** 显示名（相对路径的最后一段）。 */
  name: string;
  /** 相对工作区根的路径（正斜杠），用作折叠态的键；根占位节点为空串。 */
  relPath: string;
  /** 子节点，已按「目录在前、名称升序」排好；文件叶子为空数组。 */
  children: HttpTreeNode[];
  /** 该节点对应的请求文件；目录节点缺省（用 undefined 判定目录）。 */
  file?: HttpRestFile;
};

/** 树展平后的列表行：目录行带节点与展开态，文件行只带文件。 */
export type HttpTreeRow =
  | /** 目录行 */ {
      /** 行类型判别字段，固定 'folder'。 */
      kind: "folder";
      /** 目录节点本身。 */
      node: HttpTreeNode;
      /** 缩进深度，顶层为 0。 */
      depth: number;
      /** 是否展开；false 时其子树不出现在行列表中。 */
      isExpanded: boolean;
    }
  | /** 文件行 */ {
      /** 行类型判别字段，固定 'file'。 */
      kind: "file";
      /** 该行的请求文件。 */
      file: HttpRestFile;
      /** 缩进深度，顶层为 0。 */
      depth: number;
    };

/** renderHttpList 的入参。 */
export type HttpViewOptions = {
  /** 扫描到的请求文件；空数组渲染空态。 */
  files: HttpRestFile[];
  /** 是否正在扫描；true 时列表区显示进行态文案。 */
  scanning: boolean;
  /** 是否因目录预算触顶而未扫完；true 时列表尾部追加一条不完整说明。 */
  truncated: boolean;
  /** 列目录失败的目录数；>0 时列表尾部追加一条不完整说明。 */
  failedCount: number;
  /** 当前选中的文件绝对路径；未选中为 null。 */
  selectedPath: string | null;
  /** 折叠中的目录相对路径集合；不在集合内的目录默认展开。 */
  collapsed: Set<string>;
  /** 单击文件行回调 (file)。 */
  onOpenFile?: (file: HttpRestFile) => void;
  /** 折叠/展开目录回调 (relPath)。 */
  onToggleCollapse?: (relPath: string) => void;
  /** 重新扫描回调；缺省时头部不渲染刷新按钮。 */
  onRefresh?: () => void;
  /** 头部「新建请求文件」回调（建在项目根）；缺省时头部不渲染这颗按钮。 */
  onCreateRequestFile?: () => void;
  /** 文件行右键回调 (file, event)；缺省时右键无动作。 */
  onContextMenu?: (file: HttpRestFile, event: MouseEvent) => void;
  /** 目录行右键回调 (node, event)；缺省时目录行的右键交给浏览器原生菜单。 */
  onFolderContextMenu?: (node: HttpTreeNode, event: MouseEvent) => void;
  /** 国际化翻译函数。 */
  t: TranslateFn;
};

/** 兄弟节点排序用的 Collator：数字感知 + 忽略大小写差异，与文件树 / 扫描结果同一档规则。 */
const NODE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * 在容器的直接子节点里找第一个带指定类名的元素。
 * @description 与 git-view 同款的存在性检查：头部与滚动容器一旦建好就常驻，
 *   重绘只动它们的内部，不用 replaceChildren 抢掉容器本身。
 * @param parent 查找范围
 * @param className 类名（不含点）
 * @returns 命中的元素；没有时 null
 */
function findDirectChild<T extends HTMLElement>(parent: HTMLElement, className: string): T | null {
  for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
    if (node.classList.contains(className)) return node as T;
  }
  return null;
}

/**
 * 由相对路径清单构造目录树。
 * @param files 请求文件清单（顺序无关，内部按路径段建中间层）
 * @returns 顶层节点数组；空清单返回空数组
 */
export function buildHttpFileTree(files: readonly HttpRestFile[]): HttpTreeNode[] {
  const root: HttpTreeNode = { name: "", relPath: "", children: [] };
  const childIndex = new Map<string, HttpTreeNode>();
  for (const file of files) {
    if (!file || !file.relPath) continue;
    const segments = String(file.relPath).split("/").filter(Boolean);
    if (!segments.length) continue;
    let current = root;
    let acc = "";
    segments.forEach((segment, index) => {
      acc = acc ? `${acc}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      const key = `${current.relPath}\u0000${acc}`;
      let child = childIndex.get(key);
      if (!child) {
        child = { name: segment, relPath: acc, children: [] };
        childIndex.set(key, child);
        current.children.push(child);
      }
      if (isLeaf) child.file = file;
      current = child;
    });
  }
  const sortNodes = (nodes: HttpTreeNode[]): void => {
    nodes.sort((a, b) => {
      const aFolder = a.file === undefined;
      const bFolder = b.file === undefined;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return NODE_COLLATOR.compare(a.name, b.name);
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(root.children);
  return root.children;
}

/**
 * 统计节点子树里的请求文件数（目录行右侧计数）。
 * @param node 树节点
 * @returns 叶子计数
 */
export function countHttpTreeFiles(node: HttpTreeNode | null | undefined): number {
  if (!node) return 0;
  if (node.file) return 1;
  let total = 0;
  for (const child of node.children) total += countHttpTreeFiles(child);
  return total;
}

/**
 * 把树展平成可见行序列（折叠目录不产出其子树）。
 * @param nodes 顶层节点
 * @param collapsed 折叠中的目录相对路径集合
 * @returns 供逐行渲染的序列
 */
export function flattenHttpTree(nodes: readonly HttpTreeNode[], collapsed: ReadonlySet<string>): HttpTreeRow[] {
  const rows: HttpTreeRow[] = [];
  const walk = (list: readonly HttpTreeNode[], depth: number): void => {
    for (const node of list) {
      if (node.file) {
        rows.push({ kind: "file", file: node.file, depth });
        continue;
      }
      const isExpanded = !collapsed.has(node.relPath);
      rows.push({ kind: "folder", node, depth, isExpanded });
      if (isExpanded) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

/**
 * 渲染目录行：折叠箭头 + 目录名 + 子树文件数。
 * @param row 目录行数据
 * @param opts 视图选项
 * @returns 目录行元素
 */
function renderFolderRow(row: Extract<HttpTreeRow, { kind: "folder" }>, opts: HttpViewOptions): HTMLButtonElement {
  const { node, depth, isExpanded } = row;
  // 用原生 button 而不是 div+role：键盘的 Enter/Space 由浏览器激活语义接管，
  // 不用自己再绑一遍 keydown（两条路都调一次，按空格就会「展开又收起」＝看起来没反应）。
  const item = el("button", "sfe-http-row sfe-http-folder-row");
  item.type = "button";
  item.style.paddingLeft = 12 + depth * 14 + "px";
  item.title = node.relPath;
  item.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  // 重建列表后按它回焦（见 renderHttpList）：键盘用户按 Enter 展开目录不该把焦点丢掉。
  item.dataset.key = `d:${node.relPath}`;
  const nameWrap = el("span", "sfe-http-name");
  const chevron = createActionIcon(isExpanded ? "chevronDown" : "chevronRight", 13);
  nameWrap.appendChild(chevron);
  nameWrap.appendChild(createFileIconNode(node.name, true, isExpanded));
  nameWrap.appendChild(el("span", "sfe-http-name-text", node.name));
  item.appendChild(nameWrap);
  item.appendChild(el("span", "sfe-http-count", String(countHttpTreeFiles(node))));
  item.addEventListener("click", () => {
    if (typeof opts.onToggleCollapse === "function") opts.onToggleCollapse(node.relPath);
  });
  item.addEventListener("contextmenu", (event) => {
    // 与文件行同一约定：装配层没给回调就不接管这次右键，不摆一个「按了什么都不发生」的菜单。
    if (typeof opts.onFolderContextMenu !== "function") return;
    event.preventDefault();
    event.stopPropagation();
    opts.onFolderContextMenu(node, event);
  });
  return item;
}

/**
 * 渲染文件行：文件图标 + 文件名；单击即在右侧查看器打开。
 * @param row 文件行数据
 * @param opts 视图选项
 * @returns 文件行元素
 */
function renderFileRow(row: Extract<HttpTreeRow, { kind: "file" }>, opts: HttpViewOptions): HTMLButtonElement {
  const { file, depth } = row;
  const isSelected = opts.selectedPath === file.path;
  // 原生 button：键盘激活语义交给浏览器，标题行不再是「只能鼠标点」的死路。
  const item = el("button", "sfe-http-row sfe-http-file-row" + (isSelected ? " selected" : ""));
  item.type = "button";
  item.style.paddingLeft = 12 + depth * 14 + "px";
  item.title = `${file.relPath} · ${opts.t("http.clickHint", "单击查看请求")}`;
  item.setAttribute("aria-current", isSelected ? "true" : "false");
  item.dataset.key = `f:${file.path}`;
  const nameWrap = el("span", "sfe-http-name");
  nameWrap.appendChild(createFileIconNode(file.name, false, false));
  nameWrap.appendChild(el("span", "sfe-http-name-text", file.name));
  item.appendChild(nameWrap);
  item.addEventListener("click", () => {
    // 单击先就地切换选中行，再交给装配层打开文件：列表随后可能因重新扫描而重建，
    // 但重建会按 opts.selectedPath 回放选中态，两种路径下用户看到的都是同一行高亮。
    const scope = item.closest(".sfe-http-scroll");
    if (scope) {
      for (const prev of scope.querySelectorAll(".sfe-http-row.selected")) prev.classList.remove("selected");
    }
    item.classList.add("selected");
    item.setAttribute("aria-current", "true");
    if (typeof opts.onOpenFile === "function") opts.onOpenFile(file);
  });
  item.addEventListener("contextmenu", (event) => {
    if (typeof opts.onContextMenu !== "function") return;
    event.preventDefault();
    event.stopPropagation();
    opts.onContextMenu(file, event);
  });
  return item;
}

/**
 * 渲染请求文件列表（含头部与状态区）。
 * @description 头部与滚动容器首次创建后常驻，重绘只替换滚动容器内部行；
 *   这样重新扫描 / 折叠展开都不会销毁容器，滚动位置与自然选中态由 opts 回放。
 * @param parentEl 列表面板容器
 * @param opts 视图选项
 */
export function renderHttpList(parentEl: HTMLElement, opts: HttpViewOptions): void {
  const { files, scanning, t } = opts;
  let head = findDirectChild<HTMLElement>(parentEl, "sfe-http-head");
  if (!head) {
    head = el("div", "sfe-http-head");
    parentEl.appendChild(head);
  }
  head.replaceChildren();
  const title = el("div", "sfe-http-head-title");
  title.appendChild(el("span", "sfe-http-head-label", t("http.title", "REST 请求")));
  if (files.length) title.appendChild(el("span", "sfe-http-count", String(files.length)));
  head.appendChild(title);
  if (typeof opts.onCreateRequestFile === "function") {
    const createFile = el("button", "sfe-http-head-action");
    createFile.type = "button";
    createFile.title = t("http.newRequestFile", "新建请求文件");
    createFile.setAttribute("aria-label", t("http.newRequestFile", "新建请求文件"));
    // 头部两端对齐：剩余空间全部留在这颗按钮左边，它才会和「重新扫描」并排靠右，而不是被挤到中间。
    createFile.style.marginLeft = "auto";
    createFile.appendChild(createActionIcon("plus", 14));
    createFile.addEventListener("click", () => {
      if (typeof opts.onCreateRequestFile === "function") opts.onCreateRequestFile();
    });
    head.appendChild(createFile);
  }
  if (typeof opts.onRefresh === "function") {
    const refresh = el("button", "sfe-http-head-action");
    refresh.type = "button";
    refresh.title = t("http.refresh", "重新扫描");
    refresh.setAttribute("aria-label", t("http.refresh", "重新扫描"));
    refresh.appendChild(createActionIcon("refresh", 14));
    refresh.addEventListener("click", () => {
      if (typeof opts.onRefresh === "function") opts.onRefresh();
    });
    head.appendChild(refresh);
  }

  let scroll = findDirectChild<HTMLElement>(parentEl, "sfe-http-scroll");
  if (!scroll) {
    scroll = el("div", "sfe-http-scroll");
    parentEl.appendChild(scroll);
  }
  // 重绘只换行、不换容器：滚动位置必须先量后补，否则每次打开文件都跳回顶部。
  const scrollTop = scroll.scrollTop;
  // 同一件事对焦点也成立：键盘用户刚按 Enter 打开/展开，重建会把焦点元素一起摘掉。
  const activeKey =
    document.activeElement && typeof (document.activeElement as HTMLElement).closest === "function"
      ? ((document.activeElement as HTMLElement).closest(".sfe-http-row") as HTMLElement | null)?.dataset.key || ""
      : "";
  scroll.replaceChildren();

  if (!files.length) {
    const empty = el("div", "sfe-http-empty");
    empty.appendChild(
      el("div", "sfe-http-empty-title", scanning ? t("http.scanning", "正在查找请求文件…") : t("http.empty", "没有请求文件"))
    );
    // 只有「确实没有」才说明这里展示的是什么：扫描中说这句是废话，用户还没看到结论。
    if (!scanning) {
      empty.appendChild(
        el("div", "sfe-http-empty-hint", t("http.emptyHint", "当前展示项目里的 REST 请求文件（.http / .rest）"))
      );
    }
    scroll.appendChild(empty);
    scroll.scrollTop = scrollTop;
    return;
  }
  const rows = flattenHttpTree(buildHttpFileTree(files), opts.collapsed);
  for (const row of rows) {
    scroll.appendChild(row.kind === "folder" ? renderFolderRow(row, opts) : renderFileRow(row, opts));
  }
  if (opts.truncated) {
    scroll.appendChild(el("div", "sfe-http-note", t("http.truncated", "目录过多，列表可能不完整")));
  }
  if (opts.failedCount > 0) {
    scroll.appendChild(
      el("div", "sfe-http-note", t("http.scanPartial", "有 {{count}} 个目录没能读取，列表可能不完整", { count: opts.failedCount }))
    );
  }
  if (activeKey) {
    for (const candidate of Array.from(scroll.querySelectorAll<HTMLElement>(".sfe-http-row"))) {
      if (candidate.dataset.key === activeKey) {
        candidate.focus();
        break;
      }
    }
  }
  scroll.scrollTop = scrollTop;
}
