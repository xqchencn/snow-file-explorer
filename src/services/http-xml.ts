/**
 * XML 与 XPath 取值服务 (src/services/http-xml.ts)
 * @description 请求变量的正文引用支持两种路径：JSON 走 JSONPath，XML 走 XPath，
 *   例 `{{getReplies.response.body.//reply[1]/@id}}`。宿主渲染进程里进不了现成的
 *   XML DOM 实现，所以这里自带一份窄的：先做够用的 XML 解析
 *   （元素 / 属性 / 文本 / CDATA / 注释 / 处理指令 / 常见实体），
 *   再在其上跑 XPath 的一个明确子集。
 * @description 支持的 XPath 子集（子集之外的表达式一律按「没命中」返回 null，绝不猜一个值出去）：
 *   - 步与步之间 `/`（子代）与 `//`（后代，只下探子元素，不含当前节点自己）
 *   - 步名：`name`、`*`、`text()`、`@attr`（末步取属性）
 *   - 谓词：`[2]`（1 基位置）、`[@attr]`（存在）、`[@attr='v']`（相等）、`[name='v']`（子元素文本相等）
 *   - 起点：`/` 开头从文档根往下数，`//` 或裸名从全体后代里找
 * @description 取值只认第一个命中：元素给拼接后的子节点文本，属性给属性值，
 *   切不出步的表达式（`/`、`//`）给第一个顶层元素的拼接文本；后面的命中一律丢掉，不返回多值列表。
 */

/** 窄化后的 XML 节点。 */
export type XmlNode = {
  /** 节点种类。 */
  kind: "element" | "text";
  /** 元素名（text 节点为空串）。 */
  name: string;
  /** 属性表（键保留原文大小写，查找时大小写敏感——XML 本身区分）。 */
  attributes: Record<string, string>;
  /** 子节点（含文本节点）。 */
  children: XmlNode[];
  /** 文本内容（text 节点用）。 */
  text: string;
};

/** 常见实体；不认识的原样留着。 */
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** 解码实体：只认五个预定义实体与 `&#10;` / `&#x1F600;` 数字形式。 */
function decodeEntities(text: string): string {
  return String(text ?? "").replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][\w.-]*);/g, (all, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : all;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : all;
    }
    const mapped = ENTITIES.get(entity);
    return mapped === undefined ? all : mapped;
  });
}

/** 码点转字符串；超出 UTF-16 范围的脏数字按原文返回，不让整个解析因为一个坏实体崩掉。 */
function safeFromCodePoint(code: number): string {
  if (code < 0 || code > 0x10ffff) return String.fromCharCode(0);
  return String.fromCodePoint(code);
}

/** 取标签里的属性串（到匹配的 `>` 或 `/>` 为止）。 */
function readTag(text: string, index: number): { attributes: string; selfClosing: boolean; next: number } | null {
  const quote = { single: false, double: false };
  let cursor = index;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '"') quote.double = !quote.double;
    else if (char === "'") quote.single = !quote.single;
    else if (!quote.single && !quote.double) {
      if (char === "/" && text[cursor + 1] === ">") {
        return { attributes: text.slice(index, cursor), selfClosing: true, next: cursor + 2 };
      }
      if (char === ">") return { attributes: text.slice(index, cursor), selfClosing: false, next: cursor + 1 };
    }
    cursor += 1;
  }
  return null;
}

/** 属性串切成键值表。 */
function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let matched: RegExpExecArray | null;
  while ((matched = pattern.exec(String(raw ?? ""))) !== null) {
    out[matched[1]] = decodeEntities(matched[3] ?? matched[4] ?? "");
  }
  return out;
}

/**
 * 解析一段 XML。
 * @param text XML 原文
 * @returns 文档根节点（kind 为 element，name 为空，children 为顶层元素们）；
 *   文本里没有任何元素时返回 null，调用方按「不是 XML」处理
 * @description 解析失败不抛错：标签不闭合时把余下的当文本收进去并照样返回已解析的部分，
 *   因为调用方拿它去取值，取不到自然会有「没命中」的提示，比整条请求发不出去要好。
 */
export function parseXml(text: string): XmlNode | null {
  const source = String(text ?? "");
  const root: XmlNode = { kind: "element", name: "", attributes: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let cursor = 0;
  let sawElement = false;
  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) {
      pushText(stack[stack.length - 1], source.slice(cursor));
      break;
    }
    if (open > cursor) pushText(stack[stack.length - 1], source.slice(cursor, open));
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      cursor = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const close = source.indexOf("]]>", open + 9);
      const body = close === -1 ? source.slice(open + 9) : source.slice(open + 9, close);
      pushRawText(stack[stack.length - 1], body);
      cursor = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const close = source.indexOf("?>", open + 2);
      cursor = close === -1 ? source.length : close + 2;
      continue;
    }
    if (source.startsWith("<!", open)) {
      const close = source.indexOf(">", open + 2);
      cursor = close === -1 ? source.length : close + 1;
      continue;
    }
    const closing = /^<\/([\w:.-]*)/.exec(source.slice(open));
    if (closing) {
      const close = source.indexOf(">", open);
      // 只在栈里找得到同名父节点时出栈；找不到就当脏数据跳过，不把后面的内容整体带偏。
      const at = stack.findLastIndex((node, index) => index > 0 && node.name === closing[1]);
      if (at > 0) stack.length = at;
      cursor = close === -1 ? source.length : close + 1;
      continue;
    }
    const nameMatch = /^<([\w:.-]+)/.exec(source.slice(open));
    if (!nameMatch) {
      // 不是合法标签起头（正文里一个裸 `<`），按文本收掉，继续往后找。
      pushText(stack[stack.length - 1], "<");
      cursor = open + 1;
      continue;
    }
    const name = nameMatch[1];
    const tag = readTag(source, open + name.length + 1);
    if (!tag) {
      pushText(stack[stack.length - 1], source.slice(open));
      break;
    }
    const node: XmlNode = { kind: "element", name, attributes: parseAttributes(tag.attributes), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    sawElement = true;
    cursor = tag.next;
    if (!tag.selfClosing) stack.push(node);
  }
  return sawElement ? root : null;
}

/** 追加一段已解码实体的文本子节点。 */
function pushText(parent: XmlNode | undefined, raw: string): void {
  if (!parent) return;
  const value = decodeEntities(raw);
  if (value) pushRawText(parent, value);
}

/** 追加原文文本子节点（不再解码，CDATA 用）。 */
function pushRawText(parent: XmlNode, value: string): void {
  if (!value) return;
  parent.children.push({ kind: "text", name: "", attributes: {}, children: [], text: value });
}

/** 元素的拼接文本（直接子节点的文本，不递归取属性）。 */
function elementText(node: XmlNode): string {
  return node.children.map((child) => (child.kind === "text" ? child.text : elementText(child))).join("");
}

/** 一个 XPath 步。 */
type XPathStep = {
  /** 节点名、`*`、`text()` 或 `@attr`。 */
  target: string;
  /** 是否属性步。 */
  attribute: boolean;
  /** 是否文本步。 */
  textNode: boolean;
  /** 谓词串（不含方括号）。 */
  predicates: string[];
};

/** 拆出步名与谓词：`reply[1][@id='a']` → 名 reply、谓词 ['1', "@id='a'"]。 */
function parseStep(raw: string): XPathStep {
  const name = /^([^[]+)/.exec(raw)?.[1] ?? raw;
  const predicates = Array.from(raw.matchAll(/\[([^\]]*)\]/g)).map((matched) => matched[1].trim());
  const attribute = name.startsWith("@");
  const target = attribute ? name.slice(1) : name;
  return { target, attribute, textNode: target === "text()" || target === "text", predicates };
}

/** 谓词求值：位置、属性存在/相等、子元素文本相等。 */
function matchesPredicate(node: XmlNode, predicate: string, position: number): boolean {
  if (/^-?\d+$/.test(predicate)) return Number(predicate) === position;
  const attribute = /^@\s*([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?$/.exec(predicate);
  if (attribute) {
    const name = attribute[1];
    const value = attribute[2] ?? attribute[3];
    if (!Object.prototype.hasOwnProperty.call(node.attributes, name)) return false;
    return value === undefined || node.attributes[name] === value;
  }
  const childText = /^([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')$/.exec(predicate);
  if (childText) {
    const wanted = childText[2] ?? childText[3] ?? "";
    return node.children.some(
      (child) => child.kind === "element" && child.name === childText[1] && elementText(child) === wanted
    );
  }
  return false;
}

/** 按名筛出候选并逐个过谓词（位置是「在同名候选里的位置」，XPath 语义如此）。 */
function applyStep(candidates: XmlNode[], step: XPathStep): XmlNode[] {
  // `text()` 是节点测试而不是元素名：候选仍是上一层的元素，末步再取它的文本子节点。
  const named = step.textNode
    ? candidates
    : candidates.filter((node) => step.target === "*" || node.name === step.target);
  if (step.predicates.length === 0) return named;
  const out: XmlNode[] = [];
  for (const predicate of step.predicates) {
    named.forEach((node, at) => {
      if (matchesPredicate(node, predicate, at + 1)) out.push(node);
    });
  }
  return out;
}

/** XPath 求值结果：元素或属性值。 */
export type XmlQueryHit = {
  /** 命中种类。 */
  kind: "element" | "attribute" | "text" | "document";
  /** 面向变量替换的文本值。 */
  value: string;
};

/** 把路径切成「轴 + 步名」：`//a/b` → 后代 a、子代 b。谓词里不含 `/`，按斜杠切是安全的。 */
function splitSteps(expression: string): Array<{ axis: "child" | "descendant"; raw: string }> {
  const steps: Array<{ axis: "child" | "descendant"; raw: string }> = [];
  let cursor = 0;
  let axis: "child" | "descendant" = expression.startsWith("//") || !expression.startsWith("/") ? "descendant" : "child";
  while (cursor < expression.length) {
    const next = expression.slice(cursor).search(/\/(?![^[]*\])/);
    if (next === -1) {
      const raw = expression.slice(cursor);
      if (raw) steps.push({ axis, raw });
      break;
    }
    const raw = expression.slice(cursor, cursor + next);
    if (raw) steps.push({ axis, raw });
    cursor += next + 1;
    const isDescendant = expression[cursor] === "/";
    if (isDescendant) cursor += 1;
    axis = isDescendant ? "descendant" : "child";
  }
  return steps;
}

/** 取一个节点的全部后代元素（文档节点上等价于「所有元素」）。 */
function descendantElements(node: XmlNode, out: XmlNode[]): XmlNode[] {
  for (const child of node.children) {
    if (child.kind === "element") {
      out.push(child);
      descendantElements(child, out);
    }
  }
  return out;
}

/**
 * 在 XML 上跑一条 XPath 子集并取第一个命中。
 * @param xml XML 原文
 * @param path XPath 表达式
 * @returns 命中；表达式超出子集或没命中时为 null
 * @description 只取第一个命中：元素给拼接后的子节点文本，属性给属性值，`text()` 给它的第一个文本子节点、
 *   没有文本子节点时给拼接文本。任一步没筛出候选（含表达式超出支持的子集）就返回 null，
 *   不猜值，也不用前半段凑一个部分结果出来。
 */
export function selectFirstByXPath(xml: string, path: string): XmlQueryHit | null {
  const document = parseXml(xml);
  const expression = String(path ?? "").trim();
  if (!document || !expression) return null;
  const steps = splitSteps(expression);
  if (!steps.length) return { kind: "document", value: document.children[0] ? elementText(document.children[0]) : "" };

  let current: XmlNode[] = [document];
  for (let index = 0; index < steps.length; index += 1) {
    const { axis, raw } = steps[index];
    const step = parseStep(raw);
    const isLast = index === steps.length - 1;

    // 属性步不下探子元素：它取的是「当前节点自己」身上的属性，所以候选集就是 current。
    if (step.attribute) {
      if (!isLast) return null;
      const owners = current.filter(
        (node) =>
          (step.target === "*" || Object.prototype.hasOwnProperty.call(node.attributes, step.target)) &&
          step.predicates.every((predicate) => matchesPredicate(node, predicate, 1))
      );
      const hit = owners[0];
      if (!hit) return null;
      const key = step.target === "*" ? Object.keys(hit.attributes)[0] : step.target;
      if (key === undefined || !Object.prototype.hasOwnProperty.call(hit.attributes, key)) return null;
      return { kind: "attribute", value: hit.attributes[key] };
    }

    // `text()` 步同样不下探：它要的是当前元素自己的文本子节点。
    if (step.textNode) {
      if (!isLast) return null;
      const targets = applyStep(current, step);
      const first = targets[0];
      if (!first) return null;
      const text = first.children.find((child) => child.kind === "text");
      return { kind: "text", value: text ? text.text : elementText(first) };
    }

    const candidates =
      axis === "descendant"
        ? current.flatMap((node) => descendantElements(node, []))
        : current.flatMap((node) => node.children.filter((child) => child.kind === "element"));
    const matched = applyStep(candidates, step);
    if (!matched.length) return null;
    if (isLast) return { kind: "element", value: elementText(matched[0]) };
    current = matched;
  }
  return null;
}
