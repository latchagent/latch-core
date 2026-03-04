/**
 * @module preload
 * @description Electron preload script — exposes a curated API surface to the
 * renderer via contextBridge so the renderer never has direct Node.js access.
 *
 * All methods are available as `window.latch.<method>()` in the renderer.
 *
 * IPC channel convention: `latch:<module>-<action>`
 */

'use strict';

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('latch', {

  // ── Environment ────────────────────────────────────────────────────────────
  platform: process.platform,
  versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },

  // ── PTY ───────────────────────────────────────────────────────────────────
  // Note: `sessionId` in all PTY calls is the *tabId*, not the session ID.

  createPty: (payload: { sessionId: string; cwd?: string; cols: number; rows: number; env?: Record<string, string>; dockerContainerId?: string; sandboxCommand?: string; sandboxArgs?: string[] }) =>
    ipcRenderer.invoke('latch:pty-create', payload),

  writePty: (payload: { sessionId: string; data: string }) =>
    ipcRenderer.invoke('latch:pty-write', payload),

  resizePty: (payload: { sessionId: string; cols: number; rows: number }) =>
    ipcRenderer.invoke('latch:pty-resize', payload),

  killPty: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('latch:pty-kill', payload),

  onPtyData: (callback: (payload: { sessionId: string; data: string }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:pty-data', handler)
    return () => { ipcRenderer.removeListener('latch:pty-data', handler) }
  },

  onPtyExit: (callback: (payload: { sessionId: string }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:pty-exit', handler)
    return () => { ipcRenderer.removeListener('latch:pty-exit', handler) }
  },
  onResumeIdDetected: (callback: (payload: { sessionId: string; resumeId: string }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:resume-id-detected', handler)
    return () => { ipcRenderer.removeListener('latch:resume-id-detected', handler) }
  },

  // ── Git ───────────────────────────────────────────────────────────────────

  getGitStatus: (payload?: { cwd?: string }) =>
    ipcRenderer.invoke('latch:git-status', payload),

  createWorktree: (payload: { repoPath: string; branchName?: string; sessionName: string }) =>
    ipcRenderer.invoke('latch:git-create-worktree', payload),

  listWorktrees: (payload?: { repoPath: string }) =>
    ipcRenderer.invoke('latch:git-list-worktrees', payload),

  removeWorktree: (payload: { worktreePath: string }) =>
    ipcRenderer.invoke('latch:git-remove-worktree', payload),

  getGitDefaults: () => ipcRenderer.invoke('latch:git-defaults'),

  listBranches: (payload: { repoPath: string; limit?: number }) =>
    ipcRenderer.invoke('latch:git-list-branches', payload),

  getDefaultBranch: (payload: { repoPath: string }) =>
    ipcRenderer.invoke('latch:git-default-branch', payload),

  mergeBranch: (payload: { repoRoot: string; branchRef: string; worktreePath?: string | null }) =>
    ipcRenderer.invoke('latch:git-merge-branch', payload),

  // ── Harnesses ─────────────────────────────────────────────────────────────

  detectHarnesses: () => ipcRenderer.invoke('latch:harness-detect'),
  installHarness: (payload: { harnessId: string }) => ipcRenderer.invoke('latch:harness-install', payload),
  setupOpenCode: (payload: { sessionId: string; targetDir: string }) => ipcRenderer.invoke('latch:opencode-setup', payload),
  listModels: (payload: { harnessId: string }) => ipcRenderer.invoke('latch:model-list', payload),
  openExternal: (url: string) => ipcRenderer.invoke('latch:open-external', { url }),

  // ── Sessions ──────────────────────────────────────────────────────────────

  listSessionRecords: () => ipcRenderer.invoke('latch:session-list'),

  createSessionRecord: (payload: { id: string; name: string; created_at: string; status: string; repo_root?: string | null; worktree_path?: string | null; branch_ref?: string | null; policy_set?: string | null; harness_id?: string | null; harness_command?: string | null; goal?: string | null; docker_config?: string | null; project_dir?: string | null }) =>
    ipcRenderer.invoke('latch:session-create', payload),

  updateSessionRecord: (payload: { id: string; updates: Record<string, string | null | undefined> }) =>
    ipcRenderer.invoke('latch:session-update', payload),

  setSessionOverride: (payload: { id: string; override: Record<string, unknown> | null }) =>
    ipcRenderer.invoke('latch:session-set-override', payload),

  deleteSessionRecord: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:session-delete', payload),

  // ── Policies ──────────────────────────────────────────────────────────────

  listPolicies: () => ipcRenderer.invoke('latch:policy-list'),

  getPolicy: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:policy-get', payload),

  savePolicy: (policy: Record<string, unknown>) =>
    ipcRenderer.invoke('latch:policy-save', policy),

  deletePolicy: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:policy-delete', payload),

  enforcePolicy: (payload: { policyId: string; policyOverride?: Record<string, unknown> | null; harnessId: string; harnessCommand: string; worktreePath: string | null; projectDir?: string | null; sessionId?: string; authzPort?: number }) =>
    ipcRenderer.invoke('latch:policy-enforce', payload),

  // ── Skills ────────────────────────────────────────────────────────────────

  listSkills: () => ipcRenderer.invoke('latch:skills-list'),

  getSkill: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:skills-get', payload),

  saveSkill: (skill: Record<string, unknown>) =>
    ipcRenderer.invoke('latch:skills-save', skill),

  deleteSkill: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:skills-delete', payload),

  syncSkills: (payload: { harnessId: string }) =>
    ipcRenderer.invoke('latch:skills-sync', payload),

  // ── MCP Servers ─────────────────────────────────────────────────────────────

  listMcpServers: () => ipcRenderer.invoke('latch:mcp-list'),

  getMcpServer: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:mcp-get', payload),

  saveMcpServer: (server: Record<string, unknown>) =>
    ipcRenderer.invoke('latch:mcp-save', server),

  deleteMcpServer: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:mcp-delete', payload),

  syncMcpServers: (payload: { harnessId: string; targetDir?: string }) =>
    ipcRenderer.invoke('latch:mcp-sync', payload),

  introspectMcpServer: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:mcp-introspect', payload),

  // ── Docker sandbox ────────────────────────────────────────────────────────

  dockerDetect: () => ipcRenderer.invoke('latch:docker-detect'),

  dockerPull: (payload: { image: string }) =>
    ipcRenderer.invoke('latch:docker-pull', payload),

  dockerStart: (payload: { sessionId: string; image: string; workspacePath?: string; networkEnabled?: boolean; ports?: { host: number; container: number }[]; extraVolumes?: { hostPath: string; containerPath: string; readOnly: boolean }[] }) =>
    ipcRenderer.invoke('latch:docker-start', payload),

  dockerStop: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('latch:docker-stop', payload),

  dockerStatus: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('latch:docker-status', payload),

  onDockerStatus: (callback: (payload: { sessionId: string; status: string }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:docker-status', handler)
    return () => { ipcRenderer.removeListener('latch:docker-status', handler) }
  },

  // ── Sandbox ────────────────────────────────────────────────────────────────

  sandboxDetect: () => ipcRenderer.invoke('latch:sandbox-detect'),

  sandboxStatus: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('latch:sandbox-status', payload),

  // ── Gateway orchestration ──────────────────────────────────────────────

  startGateway: (payload: { sessionId: string; serviceIds: string[]; maxDataTier: string; policyId: string; policyOverride?: Record<string, unknown> | null; workspacePath: string | null; enableTls?: boolean }) =>
    ipcRenderer.invoke('latch:gateway-start', payload),

  stopGateway: (payload: { sessionId: string; exitReason?: string }) =>
    ipcRenderer.invoke('latch:gateway-stop', payload),

  addGatewayService: (payload: { sessionId: string; serviceId: string }) =>
    ipcRenderer.invoke('latch:gateway-add-service', payload),

  // ── Activity / Authz ──────────────────────────────────────────────────────

  listActivity: (payload?: { sessionId?: string; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('latch:activity-list', payload),

  clearActivity: (payload?: { sessionId?: string }) =>
    ipcRenderer.invoke('latch:activity-clear', payload),

  exportActivity: (payload?: { sessionId?: string; format?: 'json' | 'csv' }) =>
    ipcRenderer.invoke('latch:activity-export', payload),

  getRadarSignals: () => ipcRenderer.invoke('latch:radar-signals'),

  getAuthzPort: () => ipcRenderer.invoke('latch:authz-port'),

  authzRegister: (payload: { sessionId: string; harnessId: string; policyIds: string[]; policyOverride?: Record<string, unknown> | null }) =>
    ipcRenderer.invoke('latch:authz-register', payload),

  authzUnregister: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('latch:authz-unregister', payload),

  onActivityEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:activity-event', handler)
    return () => { ipcRenderer.removeListener('latch:activity-event', handler) }
  },

  onRadarSignal: (callback: (signal: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:radar-signal', handler)
    return () => { ipcRenderer.removeListener('latch:radar-signal', handler) }
  },

  // ── Approval flow ──────────────────────────────────────────────────────────

  resolveApproval: (payload: { id: string; decision: string }) =>
    ipcRenderer.invoke('latch:approval-resolve', payload),

  onApprovalRequest: (callback: (approval: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:approval-request', handler)
    return () => { ipcRenderer.removeListener('latch:approval-request', handler) }
  },

  onApprovalResolved: (callback: (payload: { id: string }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:approval-resolved', handler)
    return () => { ipcRenderer.removeListener('latch:approval-resolved', handler) }
  },

  // ── Supervisor ──────────────────────────────────────────────────────────

  supervisorRegisterTab: (payload: { tabId: string; sessionId: string; harnessId: string }) =>
    ipcRenderer.invoke('latch:supervisor-register-tab', payload),

  onSupervisorAction: (callback: (action: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:supervisor-action', handler)
    return () => { ipcRenderer.removeListener('latch:supervisor-action', handler) }
  },

  // ── Project stack detection ────────────────────────────────────────────

  detectProjectStack: (payload: { cwd: string }) =>
    ipcRenderer.invoke('latch:detect-project-stack', payload),

  // ── Directory picker ──────────────────────────────────────────────────

  pickDirectory: () => ipcRenderer.invoke('latch:pick-directory'),

  // ── Agents ──────────────────────────────────────────────────────────────

  readAgents: (payload: { dir: string }) =>
    ipcRenderer.invoke('latch:agents-read', payload),

  writeAgents: (payload: { filePath: string; content: string }) =>
    ipcRenderer.invoke('latch:agents-write', payload),

  // ── Policy generation (LLM) ─────────────────────────────────────────────

  generatePolicy: (payload: { prompt: string }) =>
    ipcRenderer.invoke('latch:policy-generate', payload),

  // ── Session title generation (LLM) ──────────────────────────────────────

  generateSessionTitle: (payload: { goal: string }) =>
    ipcRenderer.invoke('latch:generate-session-title', payload),

  // ── Updater ──────────────────────────────────────────────────────────────

  checkForUpdates: () => ipcRenderer.invoke('latch:updater-check'),

  downloadUpdate: () => ipcRenderer.invoke('latch:updater-download'),

  installUpdate: () => ipcRenderer.invoke('latch:updater-install'),

  getUpdateState: () => ipcRenderer.invoke('latch:updater-state'),

  onUpdaterStatus: (callback: (status: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:updater-status', handler)
    return () => { ipcRenderer.removeListener('latch:updater-status', handler) }
  },

  // ── Settings (encrypted key-value store) ────────────────────────────────

  getSetting: (payload: { key: string }) =>
    ipcRenderer.invoke('latch:settings-get', payload),

  setSetting: (payload: { key: string; value: string; sensitive?: boolean }) =>
    ipcRenderer.invoke('latch:settings-set', payload),

  deleteSetting: (payload: { key: string }) =>
    ipcRenderer.invoke('latch:settings-delete', payload),

  hasSetting: (payload: { key: string }) =>
    ipcRenderer.invoke('latch:settings-has', payload),

  // ── Secrets ────────────────────────────────────────────────────────────

  listSecrets: (payload?: { scope?: string }) =>
    ipcRenderer.invoke('latch:secret-list', payload),

  getSecret: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:secret-get', payload),

  saveSecret: (params: { id: string; name: string; key: string; value: string; description?: string; scope?: string; tags?: string[] }) =>
    ipcRenderer.invoke('latch:secret-save', params),

  deleteSecret: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:secret-delete', payload),

  validateSecretRefs: (payload: { env: Record<string, string> }) =>
    ipcRenderer.invoke('latch:secret-validate', payload),

  listSecretHints: () =>
    ipcRenderer.invoke('latch:secret-hints'),

  // ── 1Password ──────────────────────────────────────────────────────────

  opStatus: () => ipcRenderer.invoke('latch:op-status'),

  opConnect: () => ipcRenderer.invoke('latch:op-connect'),

  opDisconnect: () => ipcRenderer.invoke('latch:op-disconnect'),

  opListVaults: () => ipcRenderer.invoke('latch:op-vaults'),

  opListItems: (payload: { vaultId: string }) =>
    ipcRenderer.invoke('latch:op-items', payload),

  opGetItemFields: (payload: { itemId: string; vaultId: string }) =>
    ipcRenderer.invoke('latch:op-item-fields', payload),

  // ── Services (gateway) ──────────────────────────────────────────────────

  listServices: () => ipcRenderer.invoke('latch:service-list'),

  getService: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:service-get', payload),

  saveService: (payload: { definition: Record<string, unknown>; credentialValue?: string }) =>
    ipcRenderer.invoke('latch:service-save', payload),

  deleteService: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:service-delete', payload),

  getServiceCatalog: () => ipcRenderer.invoke('latch:service-catalog'),

  // ── Attestation ──────────────────────────────────────────────────────────

  getAttestation: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('latch:attestation-get', payload),

  listProxyAudit: (payload: { sessionId: string; limit?: number }) =>
    ipcRenderer.invoke('latch:attestation-audit-log', payload),

  getInclusionProof: (payload: { sessionId: string; eventId: string }) =>
    ipcRenderer.invoke('latch:attestation-inclusion-proof', payload),

  annotateGitHubPR: (payload: { sessionId: string; prUrl: string }) =>
    ipcRenderer.invoke('latch:attestation-annotate-pr', payload),

  // ── Data classification & credential lifecycle ────────────────────────

  classifyData: (payload: { body: string; service: string; contentType: string }) =>
    ipcRenderer.invoke('latch:data-classify', payload),

  refreshCredential: (payload: { serviceId: string }) =>
    ipcRenderer.invoke('latch:credential-refresh', payload),

  getCredentialStatus: (payload: { serviceId: string }) =>
    ipcRenderer.invoke('latch:credential-status', payload),

  // ── Feed (agent status updates) ────────────────────────────────────────

  listFeed: (payload?: { sessionId?: string; limit?: number }) =>
    ipcRenderer.invoke('latch:feed-list', payload),

  clearFeed: (payload?: { sessionId?: string }) =>
    ipcRenderer.invoke('latch:feed-clear', payload),

  onFeedUpdate: (callback: (item: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:feed-update', handler)
    return () => { ipcRenderer.removeListener('latch:feed-update', handler) }
  },

  // ── Usage / Observability ───────────────────────────────────────────────
  listUsage: (payload?: { sessionId?: string; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('latch:usage-list', payload),

  getUsageSummary: (payload?: { days?: number; sessionId?: string }) =>
    ipcRenderer.invoke('latch:usage-summary', payload),

  clearUsage: (payload?: { sessionId?: string }) =>
    ipcRenderer.invoke('latch:usage-clear', payload),

  exportUsage: (payload?: { sessionId?: string; format?: 'json' | 'csv' }) =>
    ipcRenderer.invoke('latch:usage-export', payload),

  onUsageEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:usage-event', handler)
    return () => { ipcRenderer.removeListener('latch:usage-event', handler) }
  },

  onUsageBackfillProgress: (callback: (progress: { current: number; total: number }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:usage-backfill-progress', handler)
    return () => { ipcRenderer.removeListener('latch:usage-backfill-progress', handler) }
  },

  onLiveEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:live-event', handler)
    return () => { ipcRenderer.removeListener('latch:live-event', handler) }
  },

  onBudgetAlert: (callback: (alert: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('latch:budget-alert', handler)
    return () => { ipcRenderer.removeListener('latch:budget-alert', handler) }
  },

  respondBudgetAlert: (payload: { alertId: string; action: string }) =>
    ipcRenderer.invoke('latch:budget-respond', payload),

  // ── Rewind / Checkpoints ─────────────────────────────────────────────

  listCheckpoints: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('latch:checkpoint-list', payload),

  searchCheckpoints: (payload: { query: string; sessionId?: string }) =>
    ipcRenderer.invoke('latch:checkpoint-search', payload),

  gitLog: (payload: { cwd: string; limit?: number }) =>
    ipcRenderer.invoke('latch:git-log', payload),

  gitDiff: (payload: { cwd: string; from: string; to?: string }) =>
    ipcRenderer.invoke('latch:git-diff', payload),

  rewind: (payload: { sessionId: string; checkpointId: string }) =>
    ipcRenderer.invoke('latch:rewind', payload),

  forkFromCheckpoint: (payload: { checkpointId: string; sourceSessionId: string }) =>
    ipcRenderer.invoke('latch:fork-checkpoint', payload),

  // ── Timeline ───────────────────────────────────────────────────────────
  listTimelineConversations: (payload?: { projectSlug?: string }) =>
    ipcRenderer.invoke('latch:timeline-conversations', payload ?? {}),

  loadTimeline: (payload: { filePath: string; sourceId?: string }) =>
    ipcRenderer.invoke('latch:timeline-load', payload),

  // ── Analytics ──────────────────────────────────────────────────────────
  getConversationAnalytics: (payload: { filePath: string }) =>
    ipcRenderer.invoke('latch:analytics-conversation', payload),

  getAnalyticsDashboard: () =>
    ipcRenderer.invoke('latch:analytics-dashboard'),

  // ── Issues ────────────────────────────────────────────────────────────
  listIssueRepos: (payload: any) =>
    ipcRenderer.invoke('latch:issue-list-repos', payload),

  listIssues: (payload: any) =>
    ipcRenderer.invoke('latch:issue-list', payload),

  getIssue: (payload: any) =>
    ipcRenderer.invoke('latch:issue-get', payload),

  createIssue: (payload: any) =>
    ipcRenderer.invoke('latch:issue-create', payload),

  updateIssue: (payload: any) =>
    ipcRenderer.invoke('latch:issue-update', payload),

  deleteIssue: (payload: any) =>
    ipcRenderer.invoke('latch:issue-delete', payload),

  startIssueSession: (payload: any) =>
    ipcRenderer.invoke('latch:issue-start-session', payload),

  linkIssueSession: (payload: any) =>
    ipcRenderer.invoke('latch:issue-link-session', payload),

  syncIssue: (payload: any) =>
    ipcRenderer.invoke('latch:issue-sync', payload),

  listLinkedIssues: () =>
    ipcRenderer.invoke('latch:issue-linked'),
});
