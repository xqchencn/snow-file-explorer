/**
 * Git 写操作服务模块 (src/services/git-actions.ts)
 * 封装宿主 window.snow 暴露的 Git 读写能力（暂存/取消暂存/提交/丢弃/生成提交信息），
 * 供插件 Git 变更视图调用。所有方法在接口不可用时安全降级。
 */

import type {
  GitBranch,
  GitCheckoutResult,
  GitCommitResult,
  GitDiffResult,
  GitFileContentResult,
  GitPushPullResult,
  GitStageResult,
  GitStatusResult,
} from "../types/host/host-git.ts";
import type {
  ResponsesApiResult,
  ResponsesApiStreamChunk,
} from "../types/host/host-api.ts";

/**
 * Git 远端同步（pull → 刷新状态 → push）的编排结果。
 */
export type GitSyncResult = {
  /** 整条链路是否成功；pull 或 push 任一步失败即为 false。 */
  success: boolean;
  /** 面向用户的结论文本；失败时为宿主返回的 git 报错摘要。 */
  message: string;
  /** 是否执行了 pull（无上游时为 false）。 */
  pulled: boolean;
  /** 是否执行了 push（刷新后 ahead 为 0 时为 false）。 */
  pushed: boolean;
  /** 编排结束时使用的最新状态；入参状态为空时透传 null。 */
  status: GitStatusResult | null;
};

/**
 * 暂存指定文件
 * @param repoPath 仓库根路径
 * @param filePaths 仓库相对路径列表
 * @returns 成功标志与宿主返回的消息文本
 */
export async function gitStage(repoPath: string, filePaths: string[]): Promise<GitStageResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitStage !== "function" || !repoPath) {
    return { success: false, message: "Git stage 接口不可用" };
  }
  return await snow.gitStage(repoPath, filePaths);
}

/**
 * 取消暂存指定文件
 * @param repoPath 仓库根路径
 * @param filePaths 仓库相对路径列表
 * @returns 成功标志与宿主返回的消息文本
 */
export async function gitUnstage(repoPath: string, filePaths: string[]): Promise<GitStageResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitUnstage !== "function" || !repoPath) {
    return { success: false, message: "Git unstage 接口不可用" };
  }
  return await snow.gitUnstage(repoPath, filePaths);
}

/**
 * 暂存全部变更
 * @param repoPath 仓库根路径
 * @returns 成功标志与宿主返回的消息文本
 */
export async function gitStageAll(repoPath: string): Promise<GitStageResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitStageAll !== "function" || !repoPath) {
    return { success: false, message: "Git stage-all 接口不可用" };
  }
  return await snow.gitStageAll(repoPath);
}

/**
 * 取消暂存全部
 * @param repoPath 仓库根路径
 * @returns 成功标志与宿主返回的消息文本
 */
export async function gitUnstageAll(repoPath: string): Promise<GitStageResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitUnstageAll !== "function" || !repoPath) {
    return { success: false, message: "Git unstage-all 接口不可用" };
  }
  return await snow.gitUnstageAll(repoPath);
}

/**
 * 提交已暂存内容
 * @param repoPath 仓库根路径
 * @param message 提交信息
 * @returns 成功标志、消息文本与新生成的提交号
 */
export async function gitCommit(repoPath: string, message: string): Promise<GitCommitResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitCommit !== "function" || !repoPath) {
    return { success: false, message: "Git commit 接口不可用", hash: null };
  }
  return await snow.gitCommit(repoPath, message);
}

/**
 * 丢弃工作区改动
 * @param repoPath 仓库根路径
 * @param filePaths 仓库相对路径列表
 * @returns 成功标志与宿主返回的消息文本
 */
export async function gitDiscardChanges(
  repoPath: string,
  filePaths: string[]
): Promise<GitStageResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitDiscardChanges !== "function" || !repoPath) {
    return { success: false, message: "Git discard 接口不可用" };
  }
  return await snow.gitDiscardChanges(repoPath, filePaths);
}

/**
 * 推送当前分支到远端
 * @param repoPath 仓库根路径
 * @param remote 远端名
 * @param branch 分支名
 * @param setUpstream 是否设置上游
 * @returns 成功标志与宿主返回的消息文本
 */
export async function gitPush(
  repoPath: string,
  remote?: string,
  branch?: string,
  setUpstream?: boolean
): Promise<GitPushPullResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitPush !== "function" || !repoPath) {
    return { success: false, message: "Git push 接口不可用" };
  }
  return await snow.gitPush(repoPath, remote, branch, setUpstream);
}

/**
 * 拉取远端更新到当前分支
 * @param repoPath 仓库根路径
 * @param remote 远端名
 * @param branch 分支名
 * @returns 成功标志与宿主返回的消息文本
 */
export async function gitPull(
  repoPath: string,
  remote?: string,
  branch?: string
): Promise<GitPushPullResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitPull !== "function" || !repoPath) {
    return { success: false, message: "Git pull 接口不可用" };
  }
  return await snow.gitPull(repoPath, remote, branch);
}

/**
 * 执行 Git 远端同步：先拉取，再基于最新状态推送。
 * @description 同步不是重新读取状态。若有上游，先 pull；pull 完成后调用 refreshStatus
 *   获取最新 ahead，再决定是否 push。没有上游时跳过 pull，但本地有提交时会用 -u 推送。
 * @param repoPath 仓库根路径
 * @param status 当前 Git 状态
 * @param refreshStatus pull 后重新读取 Git 状态
 * @returns 同步编排结果
 */
export async function gitSync(
  repoPath: string,
  status: GitStatusResult | null,
  refreshStatus?: () => Promise<GitStatusResult | null | undefined>
): Promise<GitSyncResult> {
  if (!repoPath || !status || !status.isRepo) {
    return { success: false, message: "Git sync 需要有效的仓库状态", pulled: false, pushed: false, status };
  }

  let current = status;
  let pulled = false;
  let pushed = false;
  const initialUpstream = String(status.upstream || "").trim();
  const initialBranch = String(status.currentBranch || "").trim();
  const initialRemote = initialUpstream ? initialUpstream.split("/")[0] : undefined;

  if (initialUpstream) {
    const pullResult = await gitPull(repoPath, initialRemote, initialBranch || undefined);
    if (!pullResult || pullResult.success === false) {
      return {
        success: false,
        message: (pullResult && pullResult.message) || "Git pull 失败",
        pulled: false,
        pushed: false,
        status: current,
      };
    }
    pulled = true;
  }

  if (typeof refreshStatus === "function") {
    current = (await refreshStatus()) || current;
  }

  const upstream = String(current.upstream || initialUpstream).trim();
  const branch = String(current.currentBranch || initialBranch).trim();
  const remote = upstream ? upstream.split("/")[0] : initialRemote;
  if (Number(current.ahead || 0) > 0) {
    const pushResult = await gitPush(repoPath, remote, branch || undefined, !upstream);
    if (!pushResult || pushResult.success === false) {
      return {
        success: false,
        message: (pushResult && pushResult.message) || "Git push 失败",
        pulled,
        pushed: false,
        status: current,
      };
    }
    pushed = true;
  }

  return { success: true, message: "Git sync 完成", pulled, pushed, status: current };
}

/**
 * 读取仓库的分支列表
 * @description 供同步栏的分支下拉使用；接口不可用或异常时返回空数组，UI 据此降级。
 * @param repoPath 仓库根路径
 * @returns 分支列表；接口不可用或异常时为空数组
 */
export async function gitBranches(repoPath: string): Promise<GitBranch[]> {
  const snow = window.snow;
  if (!snow || typeof snow.gitBranches !== "function" || !repoPath) return [];
  try {
    const res = await snow.gitBranches(repoPath);
    return Array.isArray(res) ? res : [];
  } catch (err) {
    console.warn("[FileExplorer] 读取分支列表异常:", err);
    return [];
  }
}

/**
 * 切换分支（checkout）
 * @description 远程分支同样直接传分支名：git 自身会做 DWIM 建立本地跟踪分支，
 *   与宿主 Git 面板的处理一致，插件不重复实现该逻辑。
 * @param repoPath 仓库根路径
 * @param branchName 目标分支名
 * @returns 成功标志与宿主返回的消息文本
 */
export async function gitCheckout(
  repoPath: string,
  branchName: string
): Promise<GitCheckoutResult> {
  const snow = window.snow;
  if (!snow || typeof snow.gitCheckout !== "function" || !repoPath || !branchName) {
    return { success: false, message: "Git checkout 接口不可用" };
  }
  return await snow.gitCheckout(repoPath, branchName);
}

/**
 * 读取单个文件的 Git 差异
 * @param repoPath 仓库根路径
 * @param filePath 仓库相对路径
 * @param staged 是否为已暂存区差异
 * @returns unified diff 结果；接口不可用或异常时为 null
 */
export async function gitFileDiff(
  repoPath: string,
  filePath: string,
  staged: boolean
): Promise<GitDiffResult | null> {
  const snow = window.snow;
  if (!snow || typeof snow.gitFileDiff !== "function" || !repoPath) return null;
  try {
    return await snow.gitFileDiff(repoPath, filePath, staged);
  } catch (err) {
    console.warn("[FileExplorer] 读取文件差异异常:", err);
    return null;
  }
}

/**
 * 读取文件内容（工作区或指定 revision）
 * @param repoPath 仓库根路径
 * @param filePath 仓库相对路径
 * @param revision 版本（null = 工作区）
 * @returns 该版本下的文件内容；接口不可用或异常时为 null
 */
export async function gitFileContent(
  repoPath: string,
  filePath: string,
  revision: string | null
): Promise<GitFileContentResult | null> {
  const snow = window.snow;
  if (!snow || typeof snow.gitFileContent !== "function" || !repoPath) return null;
  try {
    return await snow.gitFileContent(repoPath, filePath, revision);
  } catch (err) {
    console.warn("[FileExplorer] 读取文件内容异常:", err);
    return null;
  }
}

/**
 * 调用 AI 生成提交信息（流式）
 * @param repoPath 仓库根路径
 * @param onChunk 流式分片回调
 * @param onStreamId 流 id 回调
 * @returns 生成完毕的结果；接口不可用时为 null
 */
export async function generateCommitMessage(
  repoPath: string,
  onChunk?: (chunk: ResponsesApiStreamChunk) => void,
  onStreamId?: (streamId: string) => void
): Promise<ResponsesApiResult | null> {
  const snow = window.snow;
  if (!snow || typeof snow.generateCommitMessage !== "function" || !repoPath) {
    return null;
  }
  return await snow.generateCommitMessage(repoPath, onChunk, onStreamId);
}

/**
 * 中止提交信息生成
 * @param streamId 流 id
 */
export function abortCommitMessage(streamId: string): void {
  const snow = window.snow;
  if (snow && typeof snow.abortCommitMessage === "function" && streamId) {
    try {
      // 偏离（已登记）：宿主 abortCommitMessage 返回 Promise<boolean>，同步 try/catch 挡不住它的拒绝，
      // 中止失败原本会逃逸成 unhandled rejection；改挂 .catch 落回同一条告警。
      snow.abortCommitMessage(streamId).catch((err) => {
        console.warn("[FileExplorer] 中止提交信息生成异常:", err);
      });
    } catch (err) {
      console.warn("[FileExplorer] 中止提交信息生成异常:", err);
    }
  }
}
