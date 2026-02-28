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

  createPty: (payload: { sessionId: string; cwd?: string; cols: number; rows: number; env?: Record<string, string>; dockerContainerId?: string }) =>
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

  // ── Harnesses ─────────────────────────────────────────────────────────────

  detectHarnesses: () => ipcRenderer.invoke('latch:harness-detect'),
  openExternal: (url: string) => ipcRenderer.invoke('latch:open-external', { url }),

  // ── Sessions ──────────────────────────────────────────────────────────────

  listSessionRecords: () => ipcRenderer.invoke('latch:session-list'),

  createSessionRecord: (payload: object) =>
    ipcRenderer.invoke('latch:session-create', payload),

  updateSessionRecord: (payload: { id: string; updates: object }) =>
    ipcRenderer.invoke('latch:session-update', payload),

  setSessionOverride: (payload: { id: string; override: object | null }) =>
    ipcRenderer.invoke('latch:session-set-override', payload),

  deleteSessionRecord: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:session-delete', payload),

  // ── Policies ──────────────────────────────────────────────────────────────

  listPolicies: () => ipcRenderer.invoke('latch:policy-list'),

  getPolicy: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:policy-get', payload),

  savePolicy: (policy: object) =>
    ipcRenderer.invoke('latch:policy-save', policy),

  deletePolicy: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:policy-delete', payload),

  enforcePolicy: (payload: { policyId: string; policyOverride?: object | null; harnessId: string; harnessCommand: string; worktreePath: string | null; sessionId?: string; authzPort?: number }) =>
    ipcRenderer.invoke('latch:policy-enforce', payload),

  // ── Skills ────────────────────────────────────────────────────────────────

  listSkills: () => ipcRenderer.invoke('latch:skills-list'),

  getSkill: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:skills-get', payload),

  saveSkill: (skill: object) =>
    ipcRenderer.invoke('latch:skills-save', skill),

  deleteSkill: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:skills-delete', payload),

  syncSkills: (payload: { harnessId: string }) =>
    ipcRenderer.invoke('latch:skills-sync', payload),

  // ── MCP Servers ─────────────────────────────────────────────────────────────

  listMcpServers: () => ipcRenderer.invoke('latch:mcp-list'),

  getMcpServer: (payload: { id: string }) =>
    ipcRenderer.invoke('latch:mcp-get', payload),

  saveMcpServer: (server: object) =>
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

  // ── Activity / Authz ──────────────────────────────────────────────────────

  listActivity: (payload?: { sessionId?: string; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('latch:activity-list', payload),

  clearActivity: (payload?: { sessionId?: string }) =>
    ipcRenderer.invoke('latch:activity-clear', payload),

  exportActivity: (payload?: { sessionId?: string; format?: 'json' | 'csv' }) =>
    ipcRenderer.invoke('latch:activity-export', payload),

  getRadarSignals: () => ipcRenderer.invoke('latch:radar-signals'),

  getAuthzPort: () => ipcRenderer.invoke('latch:authz-port'),

  authzRegister: (payload: { sessionId: string; harnessId: string; policyId: string; policyOverride?: object | null }) =>
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

  // ── Secrets (vault) ────────────────────────────────────────────────────

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
});
