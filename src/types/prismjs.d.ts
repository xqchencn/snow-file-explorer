/**
 * prismjs 的类型镜像（手写，不装 @types/prismjs）。
 *
 * prismjs 自己不发类型，社区包 `@types/prismjs` 也没在本仓安装；
 * `tools/generate.mjs` 产出的 `src/components/prism-langs.ts` 只需要默认导出这一个对象，
 * 插件里真正读到的成员见下（`src/components/highlighter.ts` 的 `highlightCode`）。
 * 全部 293 条 `import "prismjs/components/prism-xxx.js"` 是纯副作用导入，不绑定任何值，
 * 所以不需要为它们声明模块路径。
 */

declare module "prismjs" {
  /** 一条语法规则：prism 的内部的递归结构（pattern / inside / alias 等），本插件只整体透传、不解读。 */
  type PrismGrammar = Record<string, unknown>;

  /** Prism 运行时对象在本插件里用到的那一面。 */
  type Prism = {
    /** 语言 id → 语法表。未注册的语言取到 undefined，调用点必须先判真值再用。 */
    languages: Record<string, PrismGrammar>;
    /**
     * 按语法表分词并产出 HTML 片段。
     * @param code 源码文本
     * @param grammar 取自 `languages` 的语法表
     * @param language 语言 id，只用于产物 class 命名
     * @returns 高亮 HTML（未做 XSS 清洗，由调用方兜底）
     */
    highlight: (code: string, grammar: PrismGrammar, language: string) => string;
  };

  const Prism: Prism;
  export default Prism;
}
