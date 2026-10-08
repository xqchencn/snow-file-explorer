/**
 * 在项目里新建文件 (src/services/file-create.ts)
 * @description 新建走宿主的原始写通道：它会连父目录一起建出来，但**不校验路径包含性**，
 *   也没有「这里已经有文件」这种判断——那两条边界由这里守：目标必须在项目根以内，
 *   同名条目一律不覆写。
 * @description 「这里有没有同名」用列目录判断，不用读文件判断：读一个不存在的文件在宿主那边是失败，
 *   拿失败当「说不清」，第一次建文件就会被自己的守卫挡住。列目录还能顺带认出同名的目录——
 *   往目录同名的位置写文件是另一种失败，提前拦住比事后解释容易。
 */

import type { TranslateFn } from "../types/panel-state.ts";
import { joinPath } from "./http-env.ts";
import { readDirectoryEntries, relativePath, writeFileContentRaw } from "./file-service.ts";

/** 新建文件被拦住的原因；界面按这个给一句话，不去猜宿主的错误文案。 */
export type CreateFileRejection =
  /** 还没打开项目，没有可以落的根。 */
  | "noRoot"
  /** 目标位置出了项目根。 */
  | "outsideRoot"
  /** 名字没给。 */
  | "emptyName"
  /** 名字带路径分隔符或操作系统非法字符。 */
  | "badName"
  /** 给了扩展名，但这个入口不收这一类文件。 */
  | "badExtension"
  /** 同名条目已存在。 */
  | "taken"
  /** 目标目录列不出来，说不清那里有没有同名。 */
  | "unreadableDirectory"
  /** 写动作失败，宿主给了原因。 */
  | "writeFailed";

/**
 * 一次新建的结果。
 * @description `name` 是补完扩展名后的最终名字，界面要说「什么已经在了」时用它，别说用户打的那半截。
 */
export type CreateFileResult =
  | { ok: true; path: string; name: string }
  | { ok: false; reason: CreateFileRejection; name: string; error: string | null };

/** Windows 不允许出现在文件名里的字符（`:` 连着盘符，分隔符两个都算：名字里带它们等于把落点带出目录）。 */
const BAD_NAME_CHARACTERS = /[\\/:*?"<>|]/;

/** 名字最后那一段扩展名（小写，不含点）；没有扩展名时空串。点在前头（`.gitignore`）不算扩展名。 */
function extensionOf(name: string): string {
  const matched = /\.([^.]+)$/.exec(String(name || ""));
  return matched ? matched[1].toLowerCase() : "";
}

/**
 * 这个名字能不能交给这个入口建：没写扩展名（由调用方补）或扩展名在名单里才算能。
 * @param name 用户打的名字（不必 trim，只看尾巴）
 * @param allowedExtensions 收哪几类扩展名（小写、不含点）；空名单表示什么都收
 * @returns 能建时 true
 * @description 弹窗里那颗「创建」和落盘前的守卫都问这一条：只在界面上拦、写盘那边不拦，
 *   绕得过；只在写盘拦、界面上给一颗点了没反应的按钮，等于骗人敲完再看红字。
 */
export function isBuildableFileName(name: string, allowedExtensions: readonly string[]): boolean {
  if (!allowedExtensions.length) return true;
  const extension = extensionOf(name);
  return !extension || allowedExtensions.includes(extension);
}

/**
 * 在指定目录里新建一个文件。
 * @param options.rootPath 项目根绝对路径
 * @param options.directoryPath 目标目录绝对路径；空串按项目根处理
 * @param options.fileName 用户给的名字（可带可不带扩展名）
 * @param options.content 建出来的正文；空串就是真正的空文件
 * @param options.extension 名字完全没有扩展名时补哪一段（形如 `.http`）；已经带扩展名的原样用，
 *   不给就不补。「已经带的是别的扩展名」不等于缺扩展名：`api.txt` 不该被补成 `api.txt.http`。
 * @param options.allowedExtensions 这个入口收哪几类扩展名（小写、不含点）；空或不给就什么都收。
 *   名字里已经写了扩展名、又不在名单里时按 `badExtension` 拦下（没写扩展名的会被补成名单里那一段）。
 * @returns 成功带回路径与最终名字；失败带回原因，文案由 `createFileRejectionMessage` 出
 */
export async function createFileInDirectory(options: {
  rootPath: string;
  directoryPath: string;
  fileName: string;
  content: string;
  extension?: string;
  allowedExtensions?: readonly string[];
}): Promise<CreateFileResult> {
  const rootPath = String(options.rootPath || "");
  if (!rootPath) return { ok: false, reason: "noRoot", name: "", error: null };

  const directory = String(options.directoryPath || "").trim() || rootPath;
  // 两头都查：目录本身要在根内，拼上占位名之后也要在根内——只查前者会被 `..` 结尾的目录带出去。
  if (!relativePath(rootPath, directory) || !relativePath(rootPath, joinPath(directory, "placeholder"))) {
    return { ok: false, reason: "outsideRoot", name: "", error: null };
  }

  let name = String(options.fileName || "").trim();
  if (!name) return { ok: false, reason: "emptyName", name, error: null };
  if (BAD_NAME_CHARACTERS.test(name) || name.includes("..")) {
    return { ok: false, reason: "badName", name, error: null };
  }
  if (!isBuildableFileName(name, options.allowedExtensions || [])) {
    return { ok: false, reason: "badExtension", name, error: null };
  }
  if (options.extension && !/\.[^.]+$/.test(name)) name = `${name}${options.extension}`;
  const target = joinPath(directory, name);

  let entries: Array<{ name?: string }> | null;
  try {
    entries = await readDirectoryEntries(directory);
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) return { ok: false, reason: "unreadableDirectory", name, error: null };
  const wanted = name.toLowerCase();
  if (entries.some((entry) => entry && String(entry.name || "").toLowerCase() === wanted)) {
    return { ok: false, reason: "taken", name, error: null };
  }

  const result = await writeFileContentRaw(target, options.content);
  if (!result.ok) return { ok: false, reason: "writeFailed", name, error: result.error || null };
  return { ok: true, path: target, name };
}

/**
 * 取一个文件所在的那一层目录（相对路径写法）。
 * @param relPath 文件相对项目根的路径（`api/orders.http`；分隔符两种都认）
 * @returns 它所在目录的相对路径（`api`）；文件就在项目根下时回空串
 * @description 新建文件的落点跟着刚点的那一处，而「那一处」常常是一个选中的文件——
 *   要的是它旁边那一个，不是它自己。空串是有意义的值（就是项目根），调用方不必再判一次。
 */
export function directoryOf(relPath: string): string {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  const at = normalized.lastIndexOf("/");
  return at < 0 ? "" : normalized.slice(0, at);
}

/**
 * 弹窗里当场判「这一格现在填的名字能不能建」。
 * @param t 翻译函数
 * @param raw 用户此刻打的字（不用先 trim）
 * @param allowedExtensions 这个入口收的扩展名（小写、不含点）；不给或空名单就是什么都收
 * @param extensionsHint 说给用户看的那一串扩展名（只有撞了扩展名那条要用，形如 `.http / .rest`）
 * @returns 还不能交的那句话；能交时为 null
 * @description 判的口径与 `createFileInDirectory` 同一条：界面上说能建、落盘时又被拦住，
 *   比一开始就不给按更难查；两头各判一套的话，迟早有一头是错的。
 *   只判这三样（空、带路径字符、扩展名不在名单），撞名与目录列不出来那些要读了盘才知道，
 *   留给落盘那一路在状态条说。
 */
export function newFileNameProblem(
  t: TranslateFn,
  raw: string,
  allowedExtensions: readonly string[] = [],
  extensionsHint = ""
): string | null {
  const name = String(raw || "").trim();
  if (!name) return createFileRejectionMessage(t, "emptyName", "");
  if (BAD_NAME_CHARACTERS.test(name) || name.includes("..")) {
    return createFileRejectionMessage(t, "badName", name);
  }
  if (!isBuildableFileName(name, allowedExtensions)) {
    return createFileRejectionMessage(t, "badExtension", name, extensionsHint);
  }
  return null;
}

/**
 * 把拦截原因翻成界面文案。
 * @param t 翻译函数
 * @param reason 拦截原因
 * @param name 最终名字（只有说得出名字才有用的那几条用得上）
 * @param extensions 这个入口收的扩展名（形如 `.http / .rest`）；只有撞了扩展名那条用得上，
 *   不给就退回不说名单的那句
 * @returns 一句给用户的话；写失败没有宿主的原话时才用这句兜底
 * @description 两处入口（请求文件列表与文件树）共用这一份措辞：同一件事在两个面板说成两句话，
 *   用户会以为是两种不同的限制。
 */
export function createFileRejectionMessage(
  t: TranslateFn,
  reason: CreateFileRejection,
  name: string,
  extensions = ""
): string {
  switch (reason) {
    case "noRoot":
      return t("action.newFileNoRoot", "还没打开项目，没有可以建文件的地方");
    case "outsideRoot":
      return t("action.newFileOutsideRoot", "只能在项目根以内建文件，这个位置出了项目范围");
    case "emptyName":
      return t("action.newFileNameEmpty", "文件名没给，建不了");
    case "badName":
      return t("action.newFileNameBad", "文件名里不能带这些字符：\\ / : * ? \" < > |");
    case "badExtension":
      return t("action.newFileBadExtension", "这里只建 {{extensions}} 文件", { extensions });
    case "taken":
      return t("action.newFileExists", "{{name}} 已经在了，没有覆盖它", { name });
    case "unreadableDirectory":
      return t("action.newFileCannotCheck", "这个目录读不出内容，没有创建文件");
    case "writeFailed":
      return t("action.newFileFailed", "文件没能创建");
  }
}
