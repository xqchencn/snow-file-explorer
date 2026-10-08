/**
 * HTTP 结果渲染 (src/components/http-result-view.ts)
 * @description 一条请求「发出去了什么、回来了什么」的完整展示：状态行、实际发出的请求、
 *   告警与错误、响应头、响应正文（JSON 走可折叠视图）。
 * @description 同一份结果两处都要用：GUI 态的卡片下方，以及文本态的右分栏——
 *   请求与响应要同屏对照，和 Git 的分栏比对是同一个理由。
 *   因此只留这一个组件、两处共用：两份实现迟早会漂移，那是 bug 的温床。
 */

import type { TranslateFn } from "../types/panel-state.ts";
import type { HttpRunResult } from "../services/http-runner.ts";
import { el, copyToClipboard } from "../utils/dom.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { highlightCodeHtml, highlighterReady, ensureHighlighter } from "./highlight-client.ts";
import { canRenderJsonView, isJsonText, renderJsonView, renderJsonHighlight } from "./json-view.ts";

/** 超过这个字符数的响应体不做 JSON 美化：几 MB 的正文 parse 一遍就够界面卡一下了。 */
const MAX_PRETTY_CHARS = 256 * 1024;

/** 超过这个字符数的响应体只渲染开头这一段，并如实说明被截断。 */
const MAX_RENDER_CHARS = 256 * 1024;

/** 超过这个字符数就不做逐行 JSON 语义着色（逐行建节点太贵），退回等宽纯文本。 */
const JSON_HL_MAX_CHARS = 128 * 1024;

/**
 * 状态码归类到语义色档：2xx 成功、3xx 提示、4xx 警告、5xx 与传输失败为错误。
 * @description `status <= 0` 也是失败：宿主断网 / 超时 / DNS 失败回的是 `status 0 + error`，
 *   把它算进成功档会在界面画出绿色的「0」，用户第一眼看到的是「成功了」。
 */
export function statusTone(result: HttpRunResult): "ok" | "redirect" | "client" | "server" | "failed" {
  if (!result.response) return "failed";
  const status = result.response.status;
  if (status <= 0) return "failed";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  if (status >= 300) return "redirect";
  return "ok";
}

/** 按 Content-Type 猜该用什么扩展名的高亮规则。 */
function extensionForContentType(contentType: string): string {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("xml") || type.includes("html")) return "markup";
  if (type.includes("css")) return "css";
  if (type.includes("javascript")) return "js";
  return "http";
}

/**
 * JSON 正文按两空格缩进美化；不是 JSON 或体量过大就原样返回。
 * @description 判定只看「能不能 parse」，不迷信 Content-Type：服务端把 JSON 标成别的类型、
 *   甚至干脆不回 Content-Type 都很常见，所以正文开头是 `{` / `[` 就先试一遍（数组响应靠这条才吃得到美化）；
 *   Content-Type 说是 JSON 的同样试。试失败原样返回，正文一个字符都不动。
 */
function prettyBody(body: string, contentType: string): string {
  if (body.length > MAX_PRETTY_CHARS) return body;
  if (!/^\s*[[{]/.test(body) && !extensionForContentType(contentType).includes("json")) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** 把头部表压成 `Name: value` 的多行文本。 */
function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers || {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/**
 * 渲染一条请求的执行结果。
 * @param parent 宿主容器
 * @param result 执行结果（含实际发出的请求）
 * @param t 翻译函数
 * @returns 结果区根元素
 */
export function renderHttpResult(parent: HTMLElement, result: HttpRunResult, t: TranslateFn): HTMLElement {
  const wrap = el("div", "sfe-http-result");
  const summary = el("div", "sfe-http-result-head");
  if (result.response) {
    const tone = statusTone(result);
    summary.appendChild(
      el("span", `sfe-http-status ${tone}`, `${result.response.status} ${result.response.statusText}`.trim())
    );
    summary.appendChild(
      el("span", "sfe-http-meta", t("http.elapsed", "{{ms}} 毫秒", { ms: result.response.elapsedMs }))
    );
    summary.appendChild(
      el("span", "sfe-http-meta", t("http.size", "{{count}} 字符", { count: result.response.bodyLength }))
    );
    if (result.response.contentType) {
      summary.appendChild(el("span", "sfe-http-meta", result.response.contentType));
    }
    // 复制响应正文：调接口最高频的动作之一，右对齐放一条，不必再进「实际发出的请求」里找。
    const actions = el("div", "sfe-http-result-actions");
    const copy = el("button", "sfe-http-copy");
    copy.type = "button";
    copy.title = t("http.copyBody", "复制响应正文");
    copy.setAttribute("aria-label", copy.title);
    copy.appendChild(createActionIcon("copy", 13));
    copy.appendChild(el("span", null, t("http.copy", "复制")));
    copy.addEventListener("click", () => {
      void copyToClipboard(result.response ? result.response.body : "").then((ok) => {
        if (!ok) return;
        copy.classList.add("copied");
        const label = copy.lastElementChild;
        if (label) label.textContent = t("action.copied", "已复制");
        window.setTimeout(() => {
          if (!copy.isConnected) return;
          copy.classList.remove("copied");
          if (label) label.textContent = t("http.copy", "复制");
        }, 1200);
      });
    });
    actions.appendChild(copy);
    summary.appendChild(actions);
  } else {
    summary.appendChild(el("span", "sfe-http-status failed", t("http.notSent", "未发出")));
  }
  wrap.appendChild(summary);

  // 实际发出的请求：变量已替换、文件已内联之后的最终形态。
  // 默认折叠——与「响应头」一样先收起，要看再展开，不抢响应正文的位置。
  // 请求行 / 头部照原文展示；正文是 JSON 时同样走语义着色（不是纯文本一坨）。
  const sentDetails = el("details", "sfe-http-sent");
  sentDetails.appendChild(el("summary", null, t("http.sentRequest", "实际发出的请求")));
  const dump = el("div", "sfe-http-sent-dump");
  dump.appendChild(el("div", "sfe-http-sent-line", `${result.sent.method} ${result.sent.url}`));
  const sentHeaders = headersToText(result.sent.headers);
  if (sentHeaders) dump.appendChild(el("div", "sfe-http-sent-line", sentHeaders));
  if (result.sent.body) {
    const sentBody = prettyBody(result.sent.body, "");
    if (isJsonText(sentBody) && sentBody.length <= JSON_HL_MAX_CHARS) {
      const host = el("div", "sfe-http-sent-body");
      renderJsonHighlight(host, sentBody);
      dump.appendChild(host);
    } else {
      dump.appendChild(el("div", "sfe-http-sent-body", result.sent.body));
    }
  }
  sentDetails.appendChild(dump);
  wrap.appendChild(sentDetails);

  for (const warning of result.warnings) wrap.appendChild(el("div", "sfe-http-warning", warning));
  if (result.error) wrap.appendChild(el("div", "sfe-http-error", result.error));

  if (result.response) {
    const details = el("details", "sfe-http-headers-details");
    const headersSummary = el("summary");
    headersSummary.appendChild(el("span", null, t("http.responseHeaders", "响应头")));
    const headerCount = Object.keys(result.response.headers || {}).length;
    if (headerCount) headersSummary.appendChild(el("span", "sfe-http-count", String(headerCount)));
    details.appendChild(headersSummary);
    details.appendChild(el("pre", "sfe-http-headers-dump", headersToText(result.response.headers)));
    wrap.appendChild(details);
    if (result.response.finalUrl && result.response.finalUrl !== result.sent.url) {
      wrap.appendChild(el("div", "sfe-http-meta", result.response.finalUrl));
    }
    const raw = prettyBody(result.response.body, result.response.contentType);
    // 宿主把响应体上限卡在 5MB，但几 MB 的节点塞进 DOM 一样能把面板拖住：只渲染开头并说明。
    const truncated = raw.length > MAX_RENDER_CHARS;
    const body = truncated ? raw.slice(0, MAX_RENDER_CHARS) : raw;
    const extension = extensionForContentType(result.response.contentType);
    if (!truncated && isJsonText(body) && canRenderJsonView(body)) {
      // JSON 走折叠视图：能逐块收起来看，长响应不再是一整坨。
      const jsonHost = el("div", "sfe-http-response-json");
      wrap.appendChild(jsonHost);
      renderJsonView(jsonHost, body, t);
    } else if (isJsonText(body) && body.length <= JSON_HL_MAX_CHARS) {
      // 太大 / 被截断而进不了折叠视图的 JSON：照样做语义着色，只是不折叠。
      const jsonHost = el("div", "sfe-http-response-json");
      const hl = el("div", "sfe-http-response-json-hl");
      jsonHost.appendChild(hl);
      renderJsonHighlight(hl, body);
      wrap.appendChild(jsonHost);
    } else {
      const pre = el("pre", "sfe-http-response-body");
      const highlighted = body.length <= 2000 ? highlightCodeHtml(body, extension) : "";
      if (highlighted) {
        pre.innerHTML = highlighted;
      } else {
        pre.textContent = body;
        // 高亮块可能还没到（首屏懒加载）：到齐后只补这一块，不重建整面板，
        // 否则会把用户正在输入的表单连光标一起换掉。懒块加载失败就保持纯文本，不往上抛。
        if (body.length <= 2000 && !highlighterReady()) {
          void ensureHighlighter()
            .then(() => {
              if (!pre.isConnected) return;
              const late = highlightCodeHtml(body, extension);
              if (late) pre.innerHTML = late;
            })
            .catch(() => undefined);
        }
      }
      wrap.appendChild(pre);
    }
    if (truncated) {
      wrap.appendChild(
        el("div", "sfe-http-meta", t("http.responseTruncated", "响应正文过长，只显示前 {{kb}} KB", { kb: Math.round(MAX_RENDER_CHARS / 1024) }))
      );
    }
  }
  parent.appendChild(wrap);
  return wrap;
}
