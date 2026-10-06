/**
 * jsdom 的类型声明（本仓未安装 `@types/jsdom`，也不允许为此新增依赖）。
 *
 * @description 只声明 `tests/src/components/**` 真正用到的那一层表面：用一段 HTML 构造
 *   JSDOM 实例，并取出它的 `window`。jsdom 的 window 实现的是标准 W3C DOM，
 *   因此直接复用 lib.dom 的 `Window & typeof globalThis`——这正是 `globalThis.window`
 *   的声明类型，测试里的 `globalThis.window = dom.window` 才在 strict 下成立。
 *   组件用到的 `dom.window.MouseEvent` / `KeyboardEvent` / `Event` / `Element.prototype`
 *   都来自 `typeof globalThis` 那部分（lib.dom 把构造器声明为全局 var）。
 */
declare module "jsdom" {
  /** JSDOM 构造选项（只声明测试用到的两项，其余 jsdom 选项不予承诺）。 */
  type JSDOMOptions = {
    /** 页面 URL；影响 `location` 与相对路径解析。测试用默认 `about:blank`，可缺。 */
    url?: string;
    /** 是否执行文档内脚本；组件测试只做静态渲染，一律不开（可缺）。 */
    runScripts?: "dangerously" | "outside-only";
  };

  /** jsdom 的一个 DOM 实例。 */
  export class JSDOM {
    /**
     * @param html 初始文档标记，缺省为 `about:blank` 空文档。
     * @param options 构造选项，可缺。
     */
    constructor(html?: string, options?: JSDOMOptions);
    /** 该实例的 window 对象，可直接赋给 `globalThis.window`。 */
    readonly window: Window & typeof globalThis;
    /** 序列化当前文档为 HTML 文本。 */
    serialize(): string;
  }
}
