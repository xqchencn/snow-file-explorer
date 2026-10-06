export type ProxyBrowserSettings = {
  enabled: boolean;
  host: string;
  port: number;
  browserPath: string;
  browserDebugPort: number;
  searchEngine: string;
  /** 正则表达式列表，匹配的站点从联网搜索结果中过滤且禁止抓取。 */
  blockedPatterns: string[];
};

export type TerminalSettings = {
  shellPath: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: number;
  /** 是否启用 GPU（WebGL2）渲染器加速终端绘制；不可用时自动回退 DOM 渲染。 */
  gpuRendering: boolean;
};

export type PrivacyApiConfig = {
  url: string;
  apiKey: string;
  model: string;
};

export type PrivacyToolResultsConfig = {
  tools: string[];
};

export type PrivacySettings = {
  enabled: boolean;
  mode: string;
  api: PrivacyApiConfig;
  toolResults: PrivacyToolResultsConfig;
};

/** Per-conversation Plan/Goal Mode overrides. `null` means the conversation
 *  has never been configured and follows the global default. */
export type ConversationModesResult = {
  planMode: boolean | null;
  goalMode: boolean | null;
  worktreeMode: boolean | null;
  workflowMode: boolean | null;
  goalModeTokenBudget: number | null;
};

export type WorkflowNodeSessionRecord = {
  conversationId: string;
  parentConversationId: string;
  flowId: string;
  /** Flow 级文件检查点：flow 首节点执行前拍摄，回滚时恢复以撤销节点文件改动。 */
  flowCheckpointId: string;
  nodeId: string;
  nodeName: string;
  runStatus: string;
  errorMessage: string;
  handoffContent: string;
  createdAt: string;
  updatedAt: string;
};

/** WorkFlow run 级状态（父会话 + flow 隔离一行）。跨重启持久化，
 *  支持从最后一个已执行节点恢复执行而非丢失全部进度。 */
export type WorkflowRunRecord = {
  parentConversationId: string;
  flowId: string;
  runStatus: string;
  currentNodeIndex: number;
  lastHandoff: string;
  totalTokens: number;
  flowCheckpointId: string;
  directoryId: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
};

/** WorkFlow 画布持久化记录（替代 localStorage）。 */
export type WorkflowCanvasRecord = {
  parentConversationId: string;
  interactionId: string;
  canvasJson: string;
  updatedAt: string;
};

/** Rust 端图校验结果（拓扑收敛的唯一实现）。 */
export type WorkflowGraphValidationResult = {
  order: string[];
  errors: string[];
};

export type ConversationRuntimeConfig = {
  thinkingStrength: string | null;
  responsesFastMode: boolean | null;
};

export type ThemeMode = "system" | "light" | "dark";

export type ThemePalette = {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  chromeBg: string;
  appBg: string;
  borderColor: string;
  borderLight: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textMuted: string;
  accentGreen: string;
  accentGreenBg: string;
  accentGreenText: string;
  accentRed: string;
  accentRedBg: string;
  accentRedText: string;
  accentBlue: string;
  accentBlueBg: string;
  accentBlueText: string;
  accentColor: string;
  onSolid: string;
  selectionBg: string;
  focusRing: string;
};

export type CustomTheme = {
  light: ThemePalette;
  dark: ThemePalette;
};

export type ThemeBackground = {
  enabled: boolean;
  imagePath: string;
  opacity: number;
  blur: number;
};

export type ThemeStreamCursor = {
  iconType: string;
  lucideName: string;
  svgPath: string;
  iconSize: number;
};

/** 排版设置：界面字号（驱动整页缩放）+ 正文字重 + 聊天正文字号 / 行高 + 代码字号。 */
export type ThemeTypography = {
  fontSize: number;
  fontWeight: number;
  chatFontSize: number;
  chatLineHeight: number;
  codeFontSize: number;
};

export type ThemeSettings = {
  mode: ThemeMode;
  presetId: string;
  custom: CustomTheme;
  background: ThemeBackground;
  fontFamily: string;
  streamCursor: ThemeStreamCursor;
  typography: ThemeTypography;
};

export type DetectedTerminal = {
  name: string;
  path: string;
  family: "powershell" | "cmd" | "wsl" | "posix";
};

export type CodebaseSettingsInput = {
  profileName: string;
  embeddingType: string;
  embeddingModelName: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingDimensions: number;
  batchMaxLines: number;
  batchConcurrency: number;
  chunkingMaxLinesPerChunk: number;
  chunkingMinLinesPerChunk: number;
  chunkingMinCharsPerChunk: number;
  chunkingOverlapLines: number;
  modelContextLength: number;
  rerankingModelName: string;
  rerankingBaseUrl: string;
  rerankingApiKey: string;
  rerankingContextLength: number;
  rerankingTopN: number;
  /** 代理审查选用的决策模型 id（空 = 使用基础 LLM 模型）。决策模型配置在 API 配置页维护。 */
  agentReviewModelId: string;
  configJson: string;
  source: string;
};

export type CodebaseProjectScopeSettings = {
  projectId: string;
  enabled?: boolean;
  enableAgentReview?: boolean;
  enableReranking?: boolean;
};

export type UsageRecord = {
  id: string;
  conversationId: string;
  responseId: string;
  model: string;
  apiProfileName: string;
  apiConfigId: string;
  requestMethod: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  status: string;
  isSubAgent: boolean;
  directoryId: string;
  createdAt: string;
  totalTokens: number;
  effectiveCacheReadTokens: number;
  nonCachedInputTokens: number;
};

export type UsageRecordPage = {
  items: UsageRecord[];
  total: number;
};

export type UsageSummary = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalRequests: number;
  errorRequests: number;
  totalTokens: number;
  effectiveCacheReadTokens: number;
  nonCachedInputTokens: number;
};

export type DailyUsageBreakdown = {
  date: string;
  totalRequests: number;
  errorRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalTokens: number;
};

export type ModelUsageBreakdown = {
  model: string;
  totalRequests: number;
  errorRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalTokens: number;
};

export type AppLogRecord = {
  id: string;
  level: string;
  module: string;
  func: string;
  line?: number;
  message: string;
  input: string;
  output: string;
  duration: string;
  context: string;
  error: string;
  source: string;
  createdAt: string;
};

export type AppLogPage = {
  items: AppLogRecord[];
  total: number;
};

export type CodebaseEmbedProgress = {
  phase: string;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  currentFile: string;
  error: string;
  elapsedMs: number;
};

export type CodebaseIndexStats = {
  totalChunks: number;
  totalFiles: number;
  totalSizeBytes: number;
  isIndexed: boolean;
};

export type CodebaseIndexedFile = {
  relativePath: string;
  filePath: string;
  chunkCount: number;
  startLine: number;
  endLine: number;
  sizeBytes: number;
  updatedAt: string;
};

export type CodebaseIndexedFilePage = {
  items: CodebaseIndexedFile[];
  total: number;
  page: number;
  pageSize: number;
};

export type CodebaseSphereRelatedFile = {
  index: number;
  similarity: number;
};

export type CodebaseSphereNode = {
  index: number;
  relativePath: string;
  chunkCount: number;
  startLine: number;
  endLine: number;
  sizeBytes: number;
  x: number;
  y: number;
  z: number;
  related: CodebaseSphereRelatedFile[];
};

export type CodebaseSphereEdge = {
  a: number;
  b: number;
  similarity: number;
};

export type CodebaseSphereLayout = {
  nodes: CodebaseSphereNode[];
  edges: CodebaseSphereEdge[];
};

export type CodebaseScanPreview = {
  fileCount: number;
  estimatedChunks: number;
  totalSizeBytes: number;
};

export type CodebaseSyncProgress = {
  phase: string;
  filesToEmbed: number;
  processedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  currentFile: string;
  error: string;
};

export type CodebaseSyncResult = {
  changed: boolean;
  embeddedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  error: string;
};

export type ResumableCodebaseSession = {
  sessionId: string;
  projectId: string;
  status: string;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  currentFile: string;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type SystemPromptItemInput = {
  promptId: string;
  name: string;
  content: string;
  isActive: boolean;
  sortOrder: number;
  scope?: "global" | "project";
  projectId?: string;
};

export type SystemPromptItemRecord = Omit<SystemPromptItemInput, "scope"> & {
  id: string;
  scope: "global" | "project";
  projectId?: string;
  updatedAt: string;
};

export type CustomHeaderSchemeInput = {
  schemeId: string;
  name: string;
  headersJson: string;
  isActive: boolean;
  sortOrder: number;
};

export type CustomHeaderSchemeRecord = CustomHeaderSchemeInput & {
  id: string;
  updatedAt: string;
};

export type CustomCommandScope = "global" | "project";
export type CustomCommandType = "prompt" | "bash";

export type CustomCommandInput = {
  commandId: string;
  scope: CustomCommandScope;
  projectId: string;
  name: string;
  commandType: CustomCommandType;
  content: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
};

export type CustomCommandRecord = CustomCommandInput & {
  /** 全局指令被同名项目指令覆盖时为 true */
  shadowed: boolean;
  updatedAt: string;
};

export type SubAgentConfigInput = {
  agentId: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolsJson: string;
  configProfile: string;
  model: string;
  builtin: boolean;
  sortOrder: number;
  source: string;
  /** 项目 ID；缺省/空表示全局子代理，指定后为项目级子代理。 */
  projectId?: string;
};

export type SubAgentConfigRecord = SubAgentConfigInput & {
  id: string;
  updatedAt: string;
  /** 项目 ID，空字符串表示全局子代理。 */
  projectId: string;
};

export type SensitiveCommandConfigInput = {
  commandId: string;
  pattern: string;
  description: string;
  enabled: boolean;
  isPreset: boolean;
  sortOrder: number;
  source: string;
};
export type SensitiveCommandConfigRecord = SensitiveCommandConfigInput & {
  id: string;
  updatedAt: string;
};

export type ProjectSensitiveCommandConfigInput = {
  commandId: string;
  pattern: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
};

export type ProjectSensitiveCommandConfigRecord =
  ProjectSensitiveCommandConfigInput & {
    inherited: boolean;
    globalEnabled: boolean;
    isPreset: boolean;
    source: string;
  };

/** 决策模型对一条命中敏感规则的命令的判定结果。 */
export type SensitiveCommandDecisionRecord = {
  /** true = 判定可以直接放行。 */
  allow: boolean;
  /** 判定理由的分类 key，由渲染层本地化展示。 */
  reason: string;
  /** 模型对判定的置信度（0-1）。 */
  confidence: number;
  /** 决策模型托管：判定直接生效，不再弹拦截提示。 */
  delegate: boolean;
  /** 参与判定的决策模型名称。 */
  modelName: string;
};

// ===== Keyboard shortcuts =====

export type KeyboardShortcutAction =
  | "cancelSession"
  | "openSearch"
  | "openMemo"
  | "openTodo"
  | "cycleProject"
  | "openProjectExplorer"
  | "openProjectMemory"
  | "openScheduledTasks"
  | "openPlugins"
  | "cycleApiProfile"
  | "toggleWindow"
  | "togglePet"
  | "focusInput"
  | "toggleSidebar"
  | "toggleRightPanel"
  | "newChat"
  | "sendMessage"
  | "stopGeneration"
  | "prevConversation"
  | "nextConversation"
  | "scrollToTop"
  | "scrollToBottom"
  | "openSettings"
  | "copyLastResponse"
  | "toggleRightPanelFullscreen"
  | "showShortcutHelp"
  | "toggleMessageTime"
  | "uiZoomIn"
  | "uiZoomOut"
  | "uiZoomReset";

export type KeyboardShortcutConfig = {
  /**
   * 平台无关的规范化按键绑定。
   * `mod` 代表平台主修饰键（macOS=Cmd，其他=Ctrl），主键用小写。
   * 例如 `mod+f`、`escape`、`mod+backtick`。
   */
  key: string;
  enabled: boolean;
  foregroundOnly: boolean;
};

export type KeyboardShortcutsSettings = {
  cancelSession: KeyboardShortcutConfig;
  openSearch: KeyboardShortcutConfig;
  openMemo: KeyboardShortcutConfig;
  openTodo: KeyboardShortcutConfig;
  cycleProject: KeyboardShortcutConfig;
  openProjectExplorer: KeyboardShortcutConfig;
  openProjectMemory: KeyboardShortcutConfig;
  openScheduledTasks: KeyboardShortcutConfig;
  openPlugins: KeyboardShortcutConfig;
  cycleApiProfile: KeyboardShortcutConfig;
  toggleWindow: KeyboardShortcutConfig;
  togglePet: KeyboardShortcutConfig;
  focusInput: KeyboardShortcutConfig;
  toggleSidebar: KeyboardShortcutConfig;
  toggleRightPanel: KeyboardShortcutConfig;
  newChat: KeyboardShortcutConfig;
  sendMessage: KeyboardShortcutConfig;
  stopGeneration: KeyboardShortcutConfig;
  prevConversation: KeyboardShortcutConfig;
  nextConversation: KeyboardShortcutConfig;
  scrollToTop: KeyboardShortcutConfig;
  scrollToBottom: KeyboardShortcutConfig;
  openSettings: KeyboardShortcutConfig;
  copyLastResponse: KeyboardShortcutConfig;
  toggleRightPanelFullscreen: KeyboardShortcutConfig;
  showShortcutHelp: KeyboardShortcutConfig;
  toggleMessageTime: KeyboardShortcutConfig;
  uiZoomIn: KeyboardShortcutConfig;
  uiZoomOut: KeyboardShortcutConfig;
  uiZoomReset: KeyboardShortcutConfig;
};

// ===== App lock =====

/** 应用锁状态：PIN 与谷歌身份验证器（TOTP）绑定情况、锁定延时与当前锁定态。 */
export type AppLockState = {
  enabled: boolean;
  hasPin: boolean;
  totpBound: boolean;
  remoteUnlock: boolean;
  delayMs: number;
  locked: boolean;
};

/** 校验结果：失败时给出剩余尝试次数或等待冷却时间。 */
export type AppLockVerifyResult = {
  ok: boolean;
  retryAfterMs: number;
  remainingAttempts: number;
};

/** 身份验证器绑定信息：Base32 密钥与 otpauth 二维码地址。 */
export type AppLockTotpBinding = {
  secret: string;
  otpauthUri: string;
};
