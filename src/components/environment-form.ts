/**
 * 「环境」弹窗里的整张表 (src/components/environment-form.ts)
 * @description 环境是导航条上的一颗颗 chip，一次只编辑一段：每段是「环境名 + 若干变量行」，
 *   段里可以加行、删行，整段也可以删掉，导航条末尾的 + 再补一段。
 *   被问到时把整张表收回来、当场判一遍能不能存——藏起来的那些段照收，保存写的仍是整张表。
 *   挂在哪里（弹窗 / 抽屉 / 整页）、填完交给谁写盘都不归它管：它既不读面板状态也不读盘。
 * @description 这篇文件自带的文件变量另占一个标签页，只念不改（它们的真身在文件正文里）；
 *   没有文件变量时这里就只有一张环境表，不摆只有一页的标签条。
 * @description 元素一次建好、之后只挪不换：宿主重绘整块面板时会连弹窗 DOM 一起重建，
 *   换成新元素等于把用户刚打进去的字抹掉。切导航、切标签页都只改「藏哪一段 / 哪一页」，
 *   所有输入框一直挂在树上，收表时才不会漏掉没在看的那几段。
 * @description 已有段的名字只念、不给输入框：改名会让「这个变量此刻是从哪一段来的」说不清，
 *   要换名字就删掉那一段再建一段。只有刚添加的那一段还能定名——它还没生效，改到什么都算数，
 *   导航条上那颗 chip 也跟着段名框实时换字。
 */

import type { TranslateFn } from "../types/panel-state.ts";
import type { HttpEnvironmentDraft } from "../services/http-env.ts";
import { SHARED_ENVIRONMENT_NAME, isStorableEnvironmentName } from "../services/http-env.ts";
import { createActionIcon } from "../icons/action-icons.ts";
import { el } from "../utils/dom.ts";

/** 一行变量：两个输入框，收集时按创建顺序读回来。 */
type EnvironmentVariableRow = {
  /** 变量名输入框。 */
  key: HTMLInputElement;
  /** 值输入框。 */
  value: HTMLInputElement;
  /** 这一行的行节点：收起多出来的空行时要连它一起摘掉。 */
  node: HTMLElement;
  /** 挂在行下的那句「私密表里也有这一项」，跟着这一行走。 */
  note: HTMLElement;
};

/** 弹窗摊开时的一段：段名与它此刻的变量行。 */
export type EnvironmentFormSection = {
  /**
   * 已有的段名；给空串表示「这一段还没有名字」——那一段的段名栏是可填的输入框，
   * 收集时按新名字查重。
   */
  name: string;
  /** 这一段里已有的变量行，按界面上的顺序逐行预填。 */
  variables: Array<{ key: string; value: string }>;
};

/** createEnvironmentForm 的入参：整张表此刻的样子，加上组件自己够不着的那两份名单。 */
export type EnvironmentFormOptions = {
  /** 翻译函数（带兜底文案与插值）；界面上的每一句文案都由它出。 */
  t: TranslateFn;
  /**
   * 摊开的这些段，顺序就是界面上的顺序（`$shared` 由调用方排到最前）。
   * @description 空数组也收：那时这里什么段都没有，组件就地给一段待命名的新环境，
   *   用户进来就能填，不必先点一次「添加环境」。
   */
  sections: EnvironmentFormSection[];
  /**
   * 已经占用的段名，保留名 `$shared` 也算占用；给新段查重用。
   * @description 由调用方给：组件不读盘，自己算不出「这个项目里有没有叫这个名字的环境」。
   */
  takenNames: string[];
  /**
   * 私密表里出现过的「段名/变量名」（形如 `production/token`）；命中的那一行下面补一句「改了不生效」。
   * @description 由调用方给（组件自己够不着私密表）。整串精确比对；省略即一行都不标。
   */
  privateKeys?: string[];
  /**
   * 这篇文件自带的文件变量（`@name = value`）；只念不改，摆在「文件变量」那一页。
   * @description 省略或空数组就没有第二页，界面上也就没有标签条——只剩一页的标签条是颗点不出名堂的控件。
   *   改这些值要回文件正文：这里写回去就是拿弹窗的副本覆盖用户的文件。
   */
  fileVariables?: Array<{ name: string; value: string }>;
};

/**
 * collect 的结果：要么是能交出去的整张表，要么是一句拦下来的理由。
 * @description 两支互斥，另一侧收成 undefined，调用方只看 error 在不在即可。
 */
export type EnvironmentFormResult =
  | { tables: HttpEnvironmentDraft[]; error?: undefined }
  | {
      error: string;
      tables?: undefined;
      /**
       * 拦下来的那一格（目前只会是出错段的段名框）：组件已把那一段切到眼前，焦点直接交给它。
       * @description 没有它调用方只好退回去聚焦开弹窗时那个框——那格多半不在出错的那段里。
       */
      offender?: HTMLInputElement;
    };

/** createEnvironmentForm 的返回值。 */
export type EnvironmentFormHandle = {
  /** 表单根节点：调用方把它挂进正文位置；节点建一次，之后只挪不换。 */
  node: HTMLElement;
  /** 弹窗打开时聚焦的那个框：有待命名的段就是那一段的段名框，否则是第一段的变量名框。 */
  focusTarget: HTMLInputElement;
  /**
   * 收整张表并判能不能存；只读输入框，不写任何东西。
   * @description 两页的输入框都一直挂着，所以站在「文件变量」那页按保存也收得着整张环境表。
   *   判不过时先切回环境变量那一页：拦下来的那一格藏在没在看的那页里，用户只会看到一句报错却找不到哪儿要改。
   */
  collect(): EnvironmentFormResult;
};

/** 弹窗里的一段：段名（只读文本或输入框）、它的变量行、导航条上那颗 chip、以及「删掉这一段」那颗钮。 */
type EnvironmentSectionBlock = {
  /** 已有的段名；新段为空串。 */
  fixedName: string;
  /** 新段的段名输入框；已有段为 null。 */
  nameInput: HTMLInputElement | null;
  /** 这一段的变量行。 */
  rows: EnvironmentVariableRow[];
  /** 这一段的根节点，删段时从表里摘掉。 */
  root: HTMLElement;
  /** 导航条上代表这一段的那颗 chip：切段、改名同步、删段摘除都动它。 */
  chip: HTMLButtonElement;
};

/**
 * 建一颗「整张环境表」表单。
 * @param options 翻译函数、此刻的段、查重用的已占用段名、私密表键名单、这篇文件的文件变量
 * @returns 根节点、该先聚焦的输入框与收集入口
 */
export function createEnvironmentForm(options: EnvironmentFormOptions): EnvironmentFormHandle {
  const { t } = options;
  const privateKeys = new Set(options.privateKeys || []);
  const fileVariables = options.fileVariables || [];
  const node = el("div", "sfe-env-form");
  // 环境表这一页先建好，段与段都往这里挂：文件变量那一页是同级兄弟，两页一起换 visibility。
  const tablesPane = el("div", "sfe-env-form-tables");
  // 导航条：环境名就是切换器，一次只编辑一段。段照旧全建、全挂在滚动区里，只是同时只露一段。
  const chips = el("div", "sfe-env-form-chips");
  const sections: EnvironmentSectionBlock[] = [];
  // 眼前正露着的那一段：删段要不要切台、拦错要切回哪段，都得先知道它是谁。
  let current: EnvironmentSectionBlock | null = null;
  let pendingFocus: HTMLInputElement | null = null;

  /**
   * 只露这一段：其余段收起来但仍挂在树上，收表时照样收得到没在看的那几段。
   * @param section 要露出来的那段
   */
  const showSection = (section: EnvironmentSectionBlock): void => {
    current = section;
    for (const item of sections) {
      item.root.hidden = item !== section;
      item.chip.classList.toggle("active", item === section);
      item.chip.setAttribute("aria-pressed", item === section ? "true" : "false");
    }
  };

  /**
   * 摘掉一行：行节点与它那句说明一起走，段里的行清单同步收掉。
   * @param section 这一行归属的那一段
   * @param row 要摘的那一行
   */
  const dropRow = (section: EnvironmentSectionBlock, row: EnvironmentVariableRow): void => {
    row.node.remove();
    row.note.remove();
    const at = section.rows.indexOf(row);
    if (at >= 0) section.rows.splice(at, 1);
  };

  /**
   * 加一行变量。
   * @param section 归属的那一段
   * @param key 预填的变量名；空串就是空行
   * @param value 预填的值
   * @param environmentName 这一段的段名（新段此刻还没名字，传空串）
   * @returns 新建的那一行，好让调用方把焦点落到变量名上
   * @description 每一行都自带一句「私密表里也有这一项，改这里不生效」的位置，并且键名一改就重查：
   *   改了不顶用的坑要在填的时候就撞见，而不是等落盘之后才发现。
   */
  const addRow = (
    section: EnvironmentSectionBlock,
    key = "",
    value = "",
    environmentName = ""
  ): EnvironmentVariableRow => {
    const row = el("div", "sfe-env-form-row");
    const keyInput = el("input", "sfe-confirm-field-input sfe-env-form-key");
    keyInput.type = "text";
    keyInput.spellcheck = false;
    keyInput.value = key;
    keyInput.placeholder = t("http.envKey", "变量名");
    keyInput.setAttribute("aria-label", keyInput.placeholder);
    const valueInput = el("input", "sfe-confirm-field-input sfe-env-form-value");
    valueInput.type = "text";
    valueInput.spellcheck = false;
    valueInput.value = value;
    valueInput.placeholder = t("http.envValue", "值");
    valueInput.setAttribute("aria-label", valueInput.placeholder);
    const remove = el("button", "sfe-env-form-remove");
    remove.type = "button";
    remove.title = t("http.removeEnvVariable", "删除这个变量");
    remove.setAttribute("aria-label", remove.title);
    remove.appendChild(createActionIcon("minus", 13));
    // 说明那一行跟着这一行走：行删掉了还留着「改这里不生效」就是一句没主的话。
    const note = el("div", "sfe-env-form-private");
    note.hidden = true;
    const created: EnvironmentVariableRow = { key: keyInput, value: valueInput, node: row, note };
    const syncNote = (): void => {
      const named = keyInput.value.trim();
      const path = `${environmentName}/${named}`;
      const shadowed = Boolean(environmentName) && Boolean(named) && privateKeys.has(path);
      note.textContent = shadowed
        ? t("http.envPrivateOverride", "私密表里也有 {{name}}，改这里不生效", { name: path })
        : "";
      note.hidden = !shadowed;
    };
    /**
     * 保证这一段末尾总有一行空行等着填：末尾那行被填掉或被删掉，就就地再补一行。
     * @description 空行本身就是「再加一项」的入口，所以不需要「添加变量」那颗按钮。
     *   补行只往末尾挂，绝不重画整段——把用户正在敲的那一格换掉就是抹掉他刚打的字。
     */
    const ensureTrailingBlankRow = (): void => {
      const last = section.rows[section.rows.length - 1];
      if (!last || last.key.value.trim()) addRow(section, "", "", environmentName);
    };
    keyInput.addEventListener("input", () => {
      syncNote();
      ensureTrailingBlankRow();
      // 这一行被清空了、末尾又还有一行空的：多的那一行收掉，只留末尾那一行（收的不是正在敲的这一格）。
      const last = section.rows[section.rows.length - 1];
      if (last && last !== created && !keyInput.value.trim()) dropRow(section, last);
    });
    syncNote();
    remove.addEventListener("click", () => {
      dropRow(section, created);
      ensureTrailingBlankRow();
    });
    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(remove);
    section.root.appendChild(row);
    section.root.appendChild(note);
    section.rows.push(created);
    // 整张表里第一个能敲的框就是弹窗该先聚焦的那个：新段是段名框（在下面建），已有段是第一行的变量名。
    if (!pendingFocus) pendingFocus = keyInput;
    return created;
  };

  /**
   * 摊开一段：段体挂进滚动区、代表它的 chip 挂进导航条；「一次只露一段」由 showSection 统一执行。
   * @param name 已有的段名；空串表示这一段待命名（段名栏给输入框）
   * @param variables 预填的变量行
   * @returns 建好的那一段
   * @description `$shared` 是保留名，段头只念、不给删除入口——删掉这一段等于删掉
   *   「对所有环境可见」这个语义，而这件事在段头一句话说不清。
   * @description 待命名段的 chip 跟着段名框实时换字：导航条上摆的就是他此刻正在敲的名字，
   *   空着时回落到「新环境」，别摆一颗写着空气的 chip。
   */
  const addSection = (name: string, variables: Array<{ key: string; value: string }>): EnvironmentSectionBlock => {
    const isNew = !name;
    const shared = name === SHARED_ENVIRONMENT_NAME;
    const root = el("div", "sfe-env-form-section");
    const head = el("div", "sfe-env-form-section-head");
    const chip = el("button", "sfe-env-form-chip");
    chip.type = "button";
    const unnamed = t("http.envChipUnnamed", "新环境");
    chip.textContent = name || unnamed;
    const section: EnvironmentSectionBlock = { fixedName: name, nameInput: null, rows: [], root, chip };

    if (isNew) {
      const nameInput = el("input", "sfe-confirm-field-input sfe-env-form-section-name");
      nameInput.type = "text";
      nameInput.spellcheck = false;
      nameInput.placeholder = t("http.envDialogNamePlaceholder", "例如 staging");
      nameInput.setAttribute("aria-label", t("http.environmentName", "环境名"));
      nameInput.addEventListener("input", () => {
        chip.textContent = nameInput.value.trim() || unnamed;
      });
      head.appendChild(nameInput);
      section.nameInput = nameInput;
      if (!pendingFocus) pendingFocus = nameInput;
    } else {
      const staticName = el("div", "sfe-env-form-section-name-static", name);
      staticName.title = t("http.envNameLocked", "环境名不能改；要换名字，删掉这个再建一个");
      head.appendChild(staticName);
    }
    if (!isNew && !shared) {
      const drop = el("button", "sfe-env-form-section-remove");
      drop.type = "button";
      drop.title = t("http.envRemoveSection", "删掉这个环境");
      drop.setAttribute("aria-label", drop.title);
      drop.appendChild(createActionIcon("minus", 13));
      drop.addEventListener("click", () => {
        root.remove();
        chip.remove();
        const at = sections.indexOf(section);
        if (at >= 0) sections.splice(at, 1);
        // 删的是眼前这段才要切台：$shared 是所有环境的公共底，它还在就回它，不然谁剩着切谁。
        if (current === section) {
          const next = sections.find((item) => item.fixedName === SHARED_ENVIRONMENT_NAME) || sections[0] || null;
          if (next) showSection(next);
          else current = null;
        }
      });
      head.appendChild(drop);
    }
    chip.addEventListener("click", () => showSection(section));
    root.appendChild(head);
    tablesPane.appendChild(root);
    chips.appendChild(chip);
    // 先收着：建完所有段后统一露第一段，进弹窗先看哪段不归建段管。
    root.hidden = true;
    sections.push(section);
    for (const variable of variables) addRow(section, variable.key, variable.value, name);
    // 末尾那一行空行就是「再加一项」的地方：填了它会自动再补一行，清空它会自动收掉。
    addRow(section, "", "", name);
    return section;
  };

  for (const section of options.sections) addSection(section.name, section.variables);
  // 一段都没有（整个项目还没有环境表）：直接给一段待命名的，别让用户先找按钮。
  if (!sections.length) addSection("", []);
  // 进来先露第一段（调用方把 $shared 排在最前）：其余段收在导航条后面，点谁编辑谁。
  showSection(sections[0]);

  // 导航条末尾的「添加环境」要带字：一颗光秃秃的小加号等于让用户猜，猜不出来就是没有这个功能。
  const add = el("button", "sfe-env-form-add-section");
  add.type = "button";
  add.appendChild(createActionIcon("plus", 12));
  add.appendChild(el("span", null, t("http.envAddSection", "添加环境")));
  add.addEventListener("click", () => {
    const section = addSection("", []);
    showSection(section);
    if (section.nameInput) section.nameInput.focus();
  });
  chips.appendChild(add);

  /** 切回环境变量那一页；没有第二页时它一直看得见，这里就是个空动作。 */
  let showTables: () => void = () => {};

  // 文件变量一页只在真有文件变量时存在：只有一页可切的标签条是颗点不出名堂的死控件。
  if (fileVariables.length) {
    const tabs = el("div", "sfe-env-form-tabs");
    tabs.setAttribute("role", "tablist");
    const environmentTab = el("button", "sfe-env-form-tab active", t("http.envTabEnvironments", "环境变量"));
    environmentTab.type = "button";
    const filesPane = el("div", "sfe-env-form-files");
    filesPane.hidden = true;
    // 这一页不给输入框：文件变量的真身在正文里，这里写回去就是拿弹窗的副本覆盖用户的文件。
    filesPane.appendChild(
      el("div", "sfe-env-form-file-hint", t("http.envFileVariableHint", "这些变量写在这篇文件里，同名时盖过环境里的值；要改值回文件正文"))
    );
    for (const variable of fileVariables) {
      const row = el("div", "sfe-env-form-file-row");
      row.appendChild(el("span", "sfe-env-form-file-name", `@${variable.name}`));
      row.appendChild(el("span", "sfe-env-form-file-value", variable.value));
      filesPane.appendChild(row);
    }
    const fileTab = el("button", "sfe-env-form-tab", t("http.envTabFileVariables", "文件变量"));
    fileTab.type = "button";
    /**
     * 只改「藏哪一页」：两页的输入框一直挂在树上，收表时才不会因为用户正看着另一页而漏掉整张环境表。
     * 导航条两页都摆着——藏了它弹窗就矮一截，两页来回切高度会上蹿下跳；
     * 文件变量那页它只是让位（置灰、点不动），不消失。
     * @param onEnvironment true 露环境变量那一页，false 露文件变量那一页
     */
    const show = (onEnvironment: boolean): void => {
      environmentTab.classList.toggle("active", onEnvironment);
      fileTab.classList.toggle("active", !onEnvironment);
      environmentTab.setAttribute("aria-selected", onEnvironment ? "true" : "false");
      fileTab.setAttribute("aria-selected", onEnvironment ? "false" : "true");
      chips.classList.toggle("dimmed", !onEnvironment);
      tablesPane.hidden = !onEnvironment;
      filesPane.hidden = onEnvironment;
    };
    environmentTab.addEventListener("click", () => show(true));
    fileTab.addEventListener("click", () => show(false));
    show(true);
    showTables = () => show(true);
    tabs.appendChild(environmentTab);
    tabs.appendChild(fileTab);
    node.appendChild(tabs);
    node.appendChild(chips);
    node.appendChild(tablesPane);
    node.appendChild(filesPane);
  } else {
    node.appendChild(chips);
    node.appendChild(tablesPane);
  }

  /** 收变量行：键 trim、空键的行丢掉、值原样不 trim。 */
  const collectVariables = (section: EnvironmentSectionBlock): Array<{ key: string; value: string }> => {
    const variables: Array<{ key: string; value: string }> = [];
    for (const row of section.rows) {
      const key = row.key.value.trim();
      // 键为空的行是「还没填」，不是「填了一个空变量」，丢掉而不是报错。
      if (!key) continue;
      // 值原样不 trim：末尾的空格对 token、URL 这类值是有内容的。
      variables.push({ key, value: row.value.value });
    }
    return variables;
  };

  const collect = (): EnvironmentFormResult => {
    /**
     * 拦下来并把出错的那段切到眼前：要改的那一格可能藏在没在看的那段里，光报错不切台等于让用户自己找。
     * @param message 拦下来的理由
     * @param section 出错的那一段
     * @param offender 出错的那一格
     */
    const reject = (
      message: string,
      section: EnvironmentSectionBlock,
      offender: HTMLInputElement
    ): EnvironmentFormResult => {
      showTables();
      showSection(section);
      return { error: message, offender };
    };
    const taken = new Set(options.takenNames.map((item) => item.trim().toLowerCase()));
    const tables: HttpEnvironmentDraft[] = [];
    for (const section of sections) {
      const name = section.nameInput ? section.nameInput.value.trim() : section.fixedName;
      if (section.nameInput) {
        // 空名字与带分隔符的名字是同一句话（isStorableEnvironmentName 把空串也算进去了）。
        if (!isStorableEnvironmentName(name)) {
          return reject(t("http.envBadName", "环境名不能为空，也不能带 / \\ 或 .."), section, section.nameInput);
        }
        // 比较口径照仓库里路径键那一套：归一大小写再比。环境名最后要拼进文件名，
        // 同一套文件系统上 Staging 与 staging 就是同一条，撞名了才写盘更难查。
        if (taken.has(name.toLowerCase())) {
          return reject(
            t("http.envDialogExists", "已经有叫 {{name}} 的环境，换个名字", { name }),
            section,
            section.nameInput
          );
        }
        taken.add(name.toLowerCase());
      }
      tables.push({ name, variables: collectVariables(section) });
    }
    return { tables };
  };

  // 上面每段都无条件补了一行空行，所以这里一定有框可聚焦。
  const focusTarget = pendingFocus || sections[0].rows[0].key;
  return { node, focusTarget, collect };
}
