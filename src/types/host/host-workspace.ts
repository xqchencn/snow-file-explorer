export type WorkspaceDirectoryKind = "local" | "ssh";

export type WorkspaceDirectoryInput = {
  directoryId: string;
  name: string;
  path: string;
  kind: WorkspaceDirectoryKind;
  isActive: boolean;
  sortOrder: number;
  source: string;
};

export type WorkspaceDirectoryRecord = WorkspaceDirectoryInput & {
  id: string;
  updatedAt: string;
  /** 最近一次校验得到的路径状态；unknown 表示尚未校验过。 */
  pathState: string;
  /** 最近一次确认存在时的绝对路径（路径失效后用于提示与重新定位）。 */
  lastKnownPath: string;
};

/** 目录路径健康状态：ok/remote 可用，其余表示路径已不可达。 */
export type WorkspaceDirectoryPathState =
  | "unknown"
  | "ok"
  | "missing"
  | "mismatch"
  | "offline"
  | "permission_error"
  | "remote";

export type WorkspaceDirectoryVerifyReport = {
  directoryId: string;
  path: string;
  kind: string;
  state: WorkspaceDirectoryPathState | string;
  lastKnownPath: string;
};

/** 项目位置迁移记录：用于查看历史并撤销。 */
export type WorkspaceRelinkRecord = {
  relinkId: string;
  oldDirectoryId: string;
  newDirectoryId: string;
  oldPath: string;
  newPath: string;
  movedBy: string;
  createdAt: string;
  undoneAt?: string | null;
};

export type WorkspaceRelinkReport = {
  relinkId: string;
  oldDirectoryId: string;
  newDirectoryId: string;
  oldPath: string;
  newPath: string;
  dryRun: boolean;
  merged: boolean;
  conversations: number;
  archivedConversations: number;
  memories: number;
  memos: number;
  scheduledTasks: number;
  collectionsTouched: number;
  settingsKeysMoved: number;
  pathsRewritten: number;
  checkpointsRewritten: number;
  codebaseReindexRequired: boolean;
  archiveUpdated: boolean;
  notes: string[];
};

export type WorkspaceRelinkResult = {
  report: WorkspaceRelinkReport;
  directories: WorkspaceDirectoryRecord[];
};

/** 项目合集 / 关联项目组：收纳项目的纯元数据容器（不对应磁盘目录）。 */
export type ProjectCollectionRecord = {
  id: string;
  collectionId: string;
  name: string;
  /** 合集统一识别色（#rrggbb）：关联项目组的圆点标识色 */
  color: string;
  sortOrder: number;
  /** 收纳的项目 directory_id 列表（按加入顺序） */
  memberDirectoryIds: string[];
  /** 参与关联项目组的成员子集：断连的成员只留在合集里 */
  linkedDirectoryIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type FailedWorkspaceDelete = {
  path: string;
  error: string;
};

/** 批量删除结果：deleted 为成功删除的路径，failed 为失败的条目及原因。 */
export type BatchWorkspaceDeleteResult = {
  deleted: string[];
  failed: FailedWorkspaceDelete[];
};

export type FileSearchResult = {
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  matchedName: boolean;
  lineMatches: Array<{ line: number; text: string }>;
};

/** 自然语言文件搜索 agent 的进度回调数据（每次工具调用一条）。 */
import type { SshFileVersion } from "./host-ssh.ts";

export type FileSearchAgentProgress = {
  round: number;
  tool: string;
  argsJson: string;
  resultPreview: string;
};

/** `git clone` 的实时进度：一条 stderr 进度行 + 解析出的百分比。 */
export type GitCloneProgress = {
  line: string;
  percent: number | null;
};

export type FileContentResult = {
  content: string;
  isBinary: boolean;
  isImage: boolean;
  isSvg: boolean;
  mimeType: string;
  encoding: string;
  size: number;
  /** Present only for remote SSH reads and used as the save CAS token. */
  remoteVersion?: SshFileVersion;
};

/**
 * 从外部拖入编辑区的文件解析结果。
 *
 * path 为磁盘绝对路径（由 webUtils.getPathForFile 解析），
 * isDirectory 标记该路径是否为目录（由主进程 fs.stat 查询）。
 * 用于在渲染层统一生成文件 chip 或图片 chip。
 */
export type DroppedPathEntry = {
  path: string;
  isDirectory: boolean;
};
