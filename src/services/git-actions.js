/**
 * Git 写操作服务模块 (src/services/git-actions.js)
 * 封装宿主 window.snow 暴露的 Git 读写能力（暂存/取消暂存/提交/丢弃/生成提交信息），
 * 供插件 Git 变更视图调用。所有方法在接口不可用时安全降级。
 */

/**
 * 暂存指定文件
 * @param {string} repoPath 仓库根路径
 * @param {string[]} filePaths 仓库相对路径列表
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function gitStage(repoPath, filePaths) {
  const snow = window.snow;
  if (!snow || typeof snow.gitStage !== "function" || !repoPath) {
    return { success: false, message: "Git stage 接口不可用" };
  }
  return await snow.gitStage(repoPath, filePaths);
}

/**
 * 取消暂存指定文件
 * @param {string} repoPath 仓库根路径
 * @param {string[]} filePaths 仓库相对路径列表
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function gitUnstage(repoPath, filePaths) {
  const snow = window.snow;
  if (!snow || typeof snow.gitUnstage !== "function" || !repoPath) {
    return { success: false, message: "Git unstage 接口不可用" };
  }
  return await snow.gitUnstage(repoPath, filePaths);
}

/**
 * 暂存全部变更
 * @param {string} repoPath 仓库根路径
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function gitStageAll(repoPath) {
  const snow = window.snow;
  if (!snow || typeof snow.gitStageAll !== "function" || !repoPath) {
    return { success: false, message: "Git stage-all 接口不可用" };
  }
  return await snow.gitStageAll(repoPath);
}

/**
 * 取消暂存全部
 * @param {string} repoPath 仓库根路径
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function gitUnstageAll(repoPath) {
  const snow = window.snow;
  if (!snow || typeof snow.gitUnstageAll !== "function" || !repoPath) {
    return { success: false, message: "Git unstage-all 接口不可用" };
  }
  return await snow.gitUnstageAll(repoPath);
}

/**
 * 提交已暂存内容
 * @param {string} repoPath 仓库根路径
 * @param {string} message 提交信息
 * @returns {Promise<{success: boolean, message: string, hash: string|null}>}
 */
export async function gitCommit(repoPath, message) {
  const snow = window.snow;
  if (!snow || typeof snow.gitCommit !== "function" || !repoPath) {
    return { success: false, message: "Git commit 接口不可用", hash: null };
  }
  return await snow.gitCommit(repoPath, message);
}

/**
 * 丢弃工作区改动
 * @param {string} repoPath 仓库根路径
 * @param {string[]} filePaths 仓库相对路径列表
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function gitDiscardChanges(repoPath, filePaths) {
  const snow = window.snow;
  if (!snow || typeof snow.gitDiscardChanges !== "function" || !repoPath) {
    return { success: false, message: "Git discard 接口不可用" };
  }
  return await snow.gitDiscardChanges(repoPath, filePaths);
}

/**
 * 推送当前分支到远端
 * @param {string} repoPath 仓库根路径
 * @param {string} [remote] 远端名
 * @param {string} [branch] 分支名
 * @param {boolean} [setUpstream] 是否设置上游
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function gitPush(repoPath, remote, branch, setUpstream) {
  const snow = window.snow;
  if (!snow || typeof snow.gitPush !== "function" || !repoPath) {
    return { success: false, message: "Git push 接口不可用" };
  }
  return await snow.gitPush(repoPath, remote, branch, setUpstream);
}

/**
 * 拉取远端更新到当前分支
 * @param {string} repoPath 仓库根路径
 * @param {string} [remote] 远端名
 * @param {string} [branch] 分支名
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function gitPull(repoPath, remote, branch) {
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
 * @param {string} repoPath 仓库根路径
 * @param {Object} status 当前 Git 状态
 * @param {() => Promise<Object|null>} [refreshStatus] pull 后重新读取 Git 状态
 * @returns {Promise<{success: boolean, message: string, pulled: boolean, pushed: boolean, status: Object}>}
 */
export async function gitSync(repoPath, status, refreshStatus) {
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
 * @param {string} repoPath 仓库根路径
 * @returns {Promise<Array<{name: string, isCurrent: boolean, isRemote: boolean, remoteName: string|null, worktreePath?: string|null}>>}
 */
export async function gitBranches(repoPath) {
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
 * @param {string} repoPath 仓库根路径
 * @param {string} branchName 目标分支名
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function gitCheckout(repoPath, branchName) {
  const snow = window.snow;
  if (!snow || typeof snow.gitCheckout !== "function" || !repoPath || !branchName) {
    return { success: false, message: "Git checkout 接口不可用" };
  }
  return await snow.gitCheckout(repoPath, branchName);
}

/**
 * 读取单个文件的 Git 差异
 * @param {string} repoPath 仓库根路径
 * @param {string} filePath 仓库相对路径
 * @param {boolean} staged 是否为已暂存区差异
 * @returns {Promise<{content: string, isBinary: boolean, error: string}|null>}
 */
export async function gitFileDiff(repoPath, filePath, staged) {
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
 * @param {string} repoPath 仓库根路径
 * @param {string} filePath 仓库相对路径
 * @param {string|null} revision 版本（null = 工作区）
 * @returns {Promise<Object|null>}
 */
export async function gitFileContent(repoPath, filePath, revision) {
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
 * @param {string} repoPath 仓库根路径
 * @param {(chunk: Object) => void} [onChunk] 流式分片回调
 * @param {(streamId: string) => void} [onStreamId] 流 id 回调
 * @returns {Promise<{status: string, content: string}|null>}
 */
export async function generateCommitMessage(repoPath, onChunk, onStreamId) {
  const snow = window.snow;
  if (!snow || typeof snow.generateCommitMessage !== "function" || !repoPath) {
    return null;
  }
  return await snow.generateCommitMessage(repoPath, onChunk, onStreamId);
}

/**
 * 中止提交信息生成
 * @param {string} streamId 流 id
 */
export function abortCommitMessage(streamId) {
  const snow = window.snow;
  if (snow && typeof snow.abortCommitMessage === "function" && streamId) {
    try {
      snow.abortCommitMessage(streamId);
    } catch (err) {
      console.warn("[FileExplorer] 中止提交信息生成异常:", err);
    }
  }
}
