// ─── Harness ──────────────────────────────────────────────────────────────────

export interface HarnessRecord {
  id: string;
  label: string;
  installed: boolean;
  recommendedCommand: string | null;
  availableCommands: { command: string; path: string }[];
  url?: string;
}

// ─── Policy ───────────────────────────────────────────────────────────────────

export type ToolRuleDecision = 'allow' | 'deny' | 'prompt'

export interface ToolRule {
  pattern: string           // exact name or prefix glob ("mcp__github__*")
  decision: ToolRuleDecision
  reason?: string
}

export interface CommandRule {
  pattern: string              // regex matched against command string
  decision: ToolRuleDecision   // 'allow' | 'deny' | 'prompt'
  reason?: string
}

export interface McpServerRule {
  server: string            // MCP server name (e.g. "github")
  decision: ToolRuleDecision
  reason?: string
}

export interface PolicyPermissions {
  allowBash: boolean;
  allowNetwork: boolean;
  allowFileWrite: boolean;
  confirmDestructive: boolean;
  blockedGlobs: string[];
  commandRules?: CommandRule[];
}

export interface ClaudePolicyConfig {
  allowedTools?: string[];
  deniedTools?: string[];
  toolRules?: ToolRule[];
  mcpServerRules?: McpServerRule[];
}

export interface CodexPolicyConfig {
  approvalMode?: 'auto' | 'read-only' | 'full';
  sandbox?: 'strict' | 'moderate' | 'permissive';
  /** Shell command prefixes to block via .rules (Starlark prefix_rule, decision="forbidden"). */
  deniedCommands?: string[];
  /** Shell command prefixes requiring user approval via .rules (decision="prompt"). */
  promptCommands?: string[];
  /** Shell environment inheritance level: all | core | none. */
  envInherit?: 'all' | 'core' | 'none';
  /** Env var glob patterns to strip (e.g. ["AWS_*", "AZURE_*"]). */
  envExclude?: string[];
  /** Feature flag overrides for .codex/config.toml [features] section. */
  features?: Record<string, boolean>;
  /** MCP tools to disable globally via disabled_tools config. */
  disabledMcpTools?: string[];
  toolRules?: ToolRule[];
  mcpServerRules?: McpServerRule[];
}

export interface OpenClawPolicyConfig {
  allowedTools?: string[];
  deniedTools?: string[];
  toolRules?: ToolRule[];
  mcpServerRules?: McpServerRule[];
}

export interface HarnessesConfig {
  claude?: ClaudePolicyConfig;
  codex?: CodexPolicyConfig;
  openclaw?: OpenClawPolicyConfig;
}

export interface PolicyDocument {
  id: string;
  name: string;
  description: string;
  permissions: PolicyPermissions;
  harnesses: HarnessesConfig;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

export type McpTransport = 'stdio' | 'http'

export interface McpServerRecord {
  id: string
  name: string
  description: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  harnesses: string[] | null
  enabled: boolean
  tags: string[]
  tools: string[]
  catalogId: string | null
}

// ─── Skill ────────────────────────────────────────────────────────────────────

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  tags: string[];
  harnesses: string[] | null;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Docker ──────────────────────────────────────────────────────────────────

export type DockerStatus = 'pulling' | 'starting' | 'running' | 'stopped' | 'error';

export interface DockerPortMapping {
  host: number;
  container: number;
}

export interface DockerVolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface DockerConfig {
  enabled: boolean;
  image: string;
  ports: DockerPortMapping[];
  extraVolumes: DockerVolumeMount[];
  containerId: string | null;
  status: DockerStatus;
}

// ─── Session ──────────────────────────────────────────────────────────────────

/** One terminal tab — each tab has its own PTY process. */
export interface TabRecord {
  id: string;
  sessionId: string;
  label: string;
  ptyReady: boolean;
  needsReconnect: boolean;
}

/** One Latch session — a unit of work with a harness, git worktree, and tabs. */
export interface SessionRecord {
  id: string;
  name: string;
  harness: string;
  harnessId: string | null;
  harnessCommand: string | null;
  policy: string;
  policyId: string;
  policyOverride: PolicyDocument | null;
  projectDir: string | null;
  repoRoot: string | null;
  worktreePath: string | null;
  branchRef: string | null;
  goal: string;
  branchName: string;
  tabs: Map<string, TabRecord>;
  activeTabId: string;
  docker: DockerConfig | null;
  needsReconnect: boolean;
  showWizard: boolean;
}

// ─── Activity / Authz ────────────────────────────────────────────────────────

export type ActionClass = 'read' | 'write' | 'execute' | 'send';
export type RiskLevel = 'low' | 'medium' | 'high';
export type AuthzDecision = 'allow' | 'deny';

export interface ActivityEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  toolName: string;
  actionClass: ActionClass;
  risk: RiskLevel;
  decision: AuthzDecision;
  reason: string | null;
  harnessId: string;
}

export interface RadarSignal {
  id: string;
  level: 'low' | 'medium' | 'high';
  message: string;
  observedAt: string;
}

export interface RadarConfig {
  sensitivity: 'low' | 'medium' | 'high';
  volumeThresholdPct: number;
  errorRateThresholdPct: number;
  timeWindowMin: number;
}

export interface HookToolPayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

// ─── Approval ────────────────────────────────────────────────────────────────

export type ApprovalDecision = 'approve' | 'deny'

export interface PendingApproval {
  id: string
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  actionClass: ActionClass
  risk: RiskLevel
  harnessId: string
  createdAt: string
  timeoutMs: number
  timeoutDefault: ApprovalDecision
}

// ─── Feed ─────────────────────────────────────────────────────────────────────

export interface FeedItem {
  id: string;
  sessionId: string;
  timestamp: string;
  message: string;
  harnessId: string;
}

// ─── Rail panels ──────────────────────────────────────────────────────────────

export type RailPanel = 'activity' | 'policy';

export type AppView = 'home' | 'policies' | 'skills' | 'agents' | 'mcp' | 'create-policy' | 'settings' | 'feed' | 'radar';

// ─── Window.latch API ─────────────────────────────────────────────────────────
// These types mirror the contextBridge API from the preload script.

export interface LatchAPI {
  platform: string;
  versions: Record<string, string>;

  createPty(payload: { sessionId: string; cwd?: string; cols: number; rows: number; env?: Record<string, string>; dockerContainerId?: string }): Promise<{ ok: boolean; pid?: number; cwd?: string; shell?: string; error?: string }>;
  writePty(payload: { sessionId: string; data: string }): Promise<{ ok: boolean }>;
  resizePty(payload: { sessionId: string; cols: number; rows: number }): Promise<{ ok: boolean }>;
  killPty(payload: { sessionId: string }): Promise<{ ok: boolean }>;
  onPtyData(callback: (payload: { sessionId: string; data: string }) => void): () => void;
  onPtyExit(callback: (payload: { sessionId: string }) => void): () => void;

  getGitStatus(payload?: { cwd?: string }): Promise<{ isRepo: boolean; root: string | null }>;
  createWorktree(payload: { repoPath: string; branchName?: string; sessionName: string }): Promise<{ ok: boolean; workspacePath?: string; branchRef?: string; error?: string }>;
  getGitDefaults(): Promise<{ workspaceRoot: string; branchPrefix: string }>;
  listWorktrees(payload?: { repoPath: string }): Promise<{ ok: boolean; worktrees?: any[]; error?: string }>;
  removeWorktree(payload: { worktreePath: string }): Promise<{ ok: boolean; error?: string }>;

  detectHarnesses(): Promise<{ ok: boolean; harnesses: HarnessRecord[] }>;
  openExternal(url: string): Promise<{ ok: boolean }>;

  listSessionRecords(): Promise<{ ok: boolean; sessions: any[] }>;
  createSessionRecord(payload: object): Promise<{ ok: boolean; error?: string }>;
  updateSessionRecord(payload: { id: string; updates: object }): Promise<{ ok: boolean }>;
  setSessionOverride(payload: { id: string; override: object | null }): Promise<{ ok: boolean }>;
  deleteSessionRecord(payload: { id: string }): Promise<{ ok: boolean }>;

  listPolicies(): Promise<{ ok: boolean; policies: PolicyDocument[] }>;
  getPolicy(payload: { id: string }): Promise<{ ok: boolean; policy: PolicyDocument }>;
  savePolicy(policy: object): Promise<{ ok: boolean; error?: string }>;
  deletePolicy(payload: { id: string }): Promise<{ ok: boolean }>;
  enforcePolicy(payload: {
    policyId: string;
    policyOverride?: PolicyDocument | null;
    harnessId: string;
    harnessCommand: string;
    worktreePath: string | null;
    projectDir?: string | null;
    sessionId?: string;
    authzPort?: number;
  }): Promise<{ ok: boolean; harnessCommand?: string; configPath?: string; error?: string }>;

  listSkills(): Promise<{ ok: boolean; skills: SkillRecord[] }>;
  getSkill(payload: { id: string }): Promise<{ ok: boolean; skill: SkillRecord }>;
  saveSkill(skill: object): Promise<{ ok: boolean; error?: string }>;
  deleteSkill(payload: { id: string }): Promise<{ ok: boolean }>;
  syncSkills(payload: { harnessId: string }): Promise<{ ok: boolean; error?: string }>;

  listMcpServers(): Promise<{ ok: boolean; servers: McpServerRecord[] }>;
  getMcpServer(payload: { id: string }): Promise<{ ok: boolean; server: McpServerRecord }>;
  saveMcpServer(server: object): Promise<{ ok: boolean; error?: string }>;
  deleteMcpServer(payload: { id: string }): Promise<{ ok: boolean }>;
  syncMcpServers(payload: { harnessId: string; targetDir?: string }): Promise<{ ok: boolean; path?: string; error?: string }>;

  // Docker sandbox
  dockerDetect(): Promise<{ ok: boolean; available: boolean; version?: string }>;
  dockerPull(payload: { image: string }): Promise<{ ok: boolean; error?: string }>;
  dockerStart(payload: { sessionId: string; image: string; workspacePath?: string; networkEnabled?: boolean; ports?: DockerPortMapping[]; extraVolumes?: DockerVolumeMount[] }): Promise<{ ok: boolean; containerId?: string; error?: string }>;
  dockerStop(payload: { sessionId: string }): Promise<{ ok: boolean; error?: string }>;
  dockerStatus(payload: { sessionId: string }): Promise<{ ok: boolean; status: DockerStatus | null; containerId: string | null }>;
  onDockerStatus(callback: (payload: { sessionId: string; status: DockerStatus }) => void): () => void;

  // Activity / Authz
  listActivity(payload?: { sessionId?: string; limit?: number; offset?: number }): Promise<{ ok: boolean; events: ActivityEvent[]; total: number }>;
  clearActivity(payload?: { sessionId?: string }): Promise<{ ok: boolean }>;
  exportActivity(payload?: { sessionId?: string; format?: 'json' | 'csv' }): Promise<{ ok: boolean; filePath?: string; count?: number; error?: string }>;
  getRadarSignals(): Promise<{ ok: boolean; signals: RadarSignal[] }>;
  getAuthzPort(): Promise<{ ok: boolean; port: number }>;
  authzRegister(payload: { sessionId: string; harnessId: string; policyId: string; policyOverride?: PolicyDocument | null }): Promise<{ ok: boolean }>;
  authzUnregister(payload: { sessionId: string }): Promise<{ ok: boolean }>;
  getAuthzSecret(): Promise<{ ok: boolean; secret: string | null }>;
  onActivityEvent(callback: (event: ActivityEvent) => void): () => void;
  onRadarSignal(callback: (signal: RadarSignal) => void): () => void;

  // Approval flow
  resolveApproval(payload: { id: string; decision: ApprovalDecision }): Promise<{ ok: boolean }>;
  onApprovalRequest(callback: (approval: PendingApproval) => void): () => void;
  onApprovalResolved(callback: (payload: { id: string }) => void): () => void;

  detectProjectStack(payload: { cwd: string }): Promise<{ ok: boolean; stack: string }>;

  pickDirectory(): Promise<{ cancelled: boolean; filePath?: string }>;

  // Agents
  readAgents(payload: { dir: string }): Promise<{ ok: boolean; content: string; filePath: string; fileName: string; error?: string }>;
  writeAgents(payload: { filePath: string; content: string }): Promise<{ ok: boolean; error?: string }>;

  // Policy generation (LLM)
  generatePolicy(payload: { prompt: string }): Promise<{ ok: boolean; policy?: PolicyDocument; error?: string }>;

  // Session title generation (LLM)
  generateSessionTitle(payload: { goal: string }): Promise<{ ok: boolean; title?: string; error?: string }>;

  // Settings (encrypted key-value store)
  getSetting(payload: { key: string }): Promise<{ ok: boolean; value: string | null; error?: string }>;
  setSetting(payload: { key: string; value: string; sensitive?: boolean }): Promise<{ ok: boolean; error?: string }>;
  deleteSetting(payload: { key: string }): Promise<{ ok: boolean; error?: string }>;
  hasSetting(payload: { key: string }): Promise<{ ok: boolean; exists: boolean; encrypted: boolean; error?: string }>;

  // Feed
  listFeed(payload?: { sessionId?: string; limit?: number }): Promise<{ ok: boolean; items: FeedItem[]; total: number }>;
  clearFeed(payload?: { sessionId?: string }): Promise<{ ok: boolean }>;
  onFeedUpdate(callback: (item: FeedItem) => void): () => void;
}

// Extend the Window interface so TypeScript knows about window.latch.
declare global {
  interface Window {
    latch: LatchAPI;
  }
}
