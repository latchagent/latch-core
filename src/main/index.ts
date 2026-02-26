/**
 * @module main
 * @description Electron main process entry point.
 *
 * Responsibilities:
 *  - Create and manage the BrowserWindow
 *  - Initialise all service singletons (PTY, SQLite stores)
 *  - Register every ipcMain.handle() channel exposed to the renderer
 *
 * Channel naming convention: `latch:<module>-<action>`
 */

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import path from 'node:path'

// Local modules — these are JS files imported as ESM so Vite will bundle them.
import {
  getGitRoot,
  createWorktree,
  listWorktrees,
  removeWorktree,
  getWorkspaceRoot,
  getBranchPrefix
} from './git-workspaces'
import { detectAllHarnesses }                   from './harnesses'
import SessionStore                              from './session-store'
import { PolicyStore }                           from './policy-store'
import { enforcePolicy }                         from './policy-enforcer'
import { generatePolicy, generateSessionTitle }  from './policy-generator'
import { SkillsStore }                           from './skills-store'
import { McpStore }                              from './mcp-store'
import { syncMcpToHarness }                      from './mcp-sync'

import PtyManager                                from './pty-manager'
import DockerManager                             from './docker-manager'
import { AuthzServer }                           from './authz-server'
import { ActivityStore }                         from './activity-store'
import { FeedStore }                            from './feed-store'
import { Radar }                                 from './radar'
import { SettingsStore }                         from './settings-store'
import { initTelemetrySDK, bindTelemetrySettings, track } from './telemetry'

// ─── Singletons ───────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow
let ptyManager: any
let dockerManager: any
let sessionStore: any
let policyStore: any
let skillsStore: any
let mcpStore: any

let authzServer: AuthzServer | null = null
let activityStore: ActivityStore | null = null
let feedStore: FeedStore | null = null
let radar: Radar | null = null
let settingsStore: SettingsStore | null = null
let db: any = null

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width:           1280,
    height:          820,
    minWidth:        1024,
    minHeight:       640,
    backgroundColor: '#05060a',
    title:           'Latch Desktop',
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true
    }
  })

  // electron-vite dev mode: load from Vite dev server; production: load built HTML.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())

  if (process.env.LATCH_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}

// ─── Telemetry SDK (must init before app.whenReady) ──────────────────────────

initTelemetrySDK('A-US-1996460381')

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  mainWindow = createWindow()

  // Shared send function for forwarding events to the renderer.
  const sendToRenderer = (channel: string, payload: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(channel, payload)
  }

  // PTY manager — forwards pty output/exit events to the renderer.
  ptyManager = new PtyManager(sendToRenderer)

  // Docker manager — forwards container status events to the renderer.
  dockerManager = new DockerManager(sendToRenderer)

  // Open (or create) the SQLite database shared by all stores.
  try {
    const Database = require('better-sqlite3')
    const dbPath   = path.join(app.getPath('userData'), 'latch.db')
    db             = new Database(dbPath)
    db.pragma('journal_mode = WAL')

    sessionStore  = SessionStore.openWithDb(db)
    policyStore   = PolicyStore.open(db)
    skillsStore   = SkillsStore.open(db)
    mcpStore      = McpStore.open(db)

    activityStore = ActivityStore.open(db)
    feedStore     = FeedStore.open(db)
    settingsStore = SettingsStore.open(db)

    // Bind telemetry to settings store (SDK already initialised above)
    bindTelemetrySettings((k) => settingsStore!.get(k))

    // Notifications on PTY exit (task completion)
    ptyManager.onExit((tabId: string) => {
      const notifSetting = settingsStore?.get('notifications-enabled')
      // Default ON (null = never set = default ON)
      if (notifSetting === 'false') return
      // Only notify when window is not focused
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return
      new Notification({
        title: 'Task complete',
        body: `Terminal session finished (${tabId}).`,
      }).show()
    })

    // Start authz server + radar
    authzServer = new AuthzServer(policyStore, activityStore, sendToRenderer)
    radar = new Radar(activityStore, sendToRenderer)
    authzServer.setRadar(radar)
    if (feedStore) authzServer.setFeedStore(feedStore)
    authzServer.setSettingsStore(settingsStore)
    authzServer.start().catch((err: any) => {
      console.error('Authz server start failed:', err?.message)
      authzServer = null
    })
    radar.start()
  } catch (err: any) {
    const unavailable = (name: string) => ({
      ok:    false,
      error: `${name} unavailable: ${err?.message}`
    })
    sessionStore = {
      listSessions:  () => unavailable('SessionStore'),
      createSession: () => unavailable('SessionStore'),
      updateSession: () => unavailable('SessionStore'),
      setOverride:   () => unavailable('SessionStore')
    }
    policyStore = {
      listPolicies: () => unavailable('PolicyStore'),
      getPolicy:    () => unavailable('PolicyStore'),
      savePolicy:   () => unavailable('PolicyStore'),
      deletePolicy: () => unavailable('PolicyStore')
    }
    skillsStore = {
      listSkills:    () => unavailable('SkillsStore'),
      getSkill:      () => unavailable('SkillsStore'),
      saveSkill:     () => unavailable('SkillsStore'),
      deleteSkill:   () => unavailable('SkillsStore'),
      syncToHarness: () => unavailable('SkillsStore')
    }
    mcpStore = {
      listServers:  () => unavailable('McpStore'),
      getServer:    () => unavailable('McpStore'),
      saveServer:   () => unavailable('McpStore'),
      deleteServer: () => unavailable('McpStore')
    }
  }

  // ── macOS re-activate ───────────────────────────────────────────────────
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  // ── PTY handlers ────────────────────────────────────────────────────────

  ipcMain.handle('latch:pty-create', async (_event, payload) => {
    try {
      // Validate Docker container ID format if provided (must be 12 hex chars).
      if (payload.dockerContainerId) {
        if (!/^[a-f0-9]{12}$/.test(payload.dockerContainerId)) {
          return { ok: false, error: 'Invalid container ID format.' }
        }
      }

      const record = ptyManager.create(payload.sessionId, {
        ...payload,
        env: payload.env,
        dockerContainerId: payload.dockerContainerId,
      })
      return { ok: true, pid: record.ptyProcess.pid, cwd: record.cwd, shell: record.shell }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to start shell.' }
    }
  })

  ipcMain.handle('latch:pty-write', async (_event, payload) => {
    try {
      ptyManager.write(payload.sessionId, payload.data)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'PTY write failed.' }
    }
  })

  ipcMain.handle('latch:pty-resize', async (_event, payload) => {
    try {
      ptyManager.resize(payload.sessionId, payload.cols, payload.rows)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'PTY resize failed.' }
    }
  })

  ipcMain.handle('latch:pty-kill', async (_event, payload) => {
    try {
      ptyManager.kill(payload.sessionId)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'PTY kill failed.' }
    }
  })

  // ── Git handlers ────────────────────────────────────────────────────────

  ipcMain.handle('latch:git-status', async (_event, { cwd } = {} as any) => {
    const root = await getGitRoot(cwd || process.cwd())
    return root ? { isRepo: true, root } : { isRepo: false, root: null }
  })

  ipcMain.handle('latch:git-create-worktree', async (_event, payload) => {
    return createWorktree(payload)
  })

  ipcMain.handle('latch:git-list-worktrees', async (_event, payload) => {
    return listWorktrees(payload?.repoPath)
  })

  ipcMain.handle('latch:git-remove-worktree', async (_event, payload) => {
    return removeWorktree(payload || {})
  })

  ipcMain.handle('latch:git-defaults', async () => ({
    workspaceRoot: getWorkspaceRoot(),
    branchPrefix:  getBranchPrefix()
  }))

  // ── Harness handlers ────────────────────────────────────────────────────

  ipcMain.handle('latch:harness-detect', async () => {
    const harnesses = await detectAllHarnesses()
    return { ok: true, harnesses }
  })

  ipcMain.handle('latch:open-external', async (_event: any, { url }: { url: string }) => {
    if (!url || typeof url !== 'string') return { ok: false }
    // Only allow http/https URLs
    if (!url.startsWith('https://') && !url.startsWith('http://')) return { ok: false }
    await shell.openExternal(url)
    return { ok: true }
  })

  // ── Session handlers ────────────────────────────────────────────────────

  ipcMain.handle('latch:session-list', async () => {
    return sessionStore.listSessions()
  })

  ipcMain.handle('latch:session-create', async (_event: any, payload: any) => {
    const result = sessionStore.createSession(payload)
    track('session_created', { harness: payload?.harness_id ?? '' })
    return result
  })

  ipcMain.handle('latch:session-update', async (_event: any, payload: any) => {
    return sessionStore.updateSession(payload.id, payload.updates)
  })

  ipcMain.handle('latch:session-set-override', async (_event: any, { id, override }: any) => {
    return sessionStore.setOverride(id, override)
  })

  ipcMain.handle('latch:session-delete', async (_event: any, { id }: any) => {
    return sessionStore.deleteSession(id)
  })

  // ── Policy handlers ─────────────────────────────────────────────────────

  ipcMain.handle('latch:policy-list', async () => {
    return policyStore.listPolicies()
  })

  ipcMain.handle('latch:policy-get', async (_event: any, { id }: any) => {
    return policyStore.getPolicy(id)
  })

  ipcMain.handle('latch:policy-save', async (_event: any, policy: any) => {
    return policyStore.savePolicy(policy)
  })

  ipcMain.handle('latch:policy-delete', async (_event: any, { id }: any) => {
    return policyStore.deletePolicy(id)
  })

  ipcMain.handle('latch:policy-enforce', async (_event: any, payload: any) => {
    // Inject authz port and secret so policy enforcer can add the PreToolUse hook
    if (authzServer) {
      payload.authzPort = authzServer.getPort()
      payload.authzSecret = authzServer.getSecret()
    }
    return enforcePolicy(policyStore, payload)
  })

  ipcMain.handle('latch:policy-generate', async (_event: any, { prompt }: any) => {
    try {
      const apiKey = settingsStore?.get('openai-api-key') ?? undefined
      const policy = await generatePolicy(prompt, apiKey)
      track('policy_generated')
      return { ok: true, policy }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Policy generation failed.' }
    }
  })

  ipcMain.handle('latch:generate-session-title', async (_event: any, { goal }: any) => {
    try {
      const apiKey = settingsStore?.get('openai-api-key') ?? undefined
      const title = await generateSessionTitle(goal, apiKey)
      return { ok: true, title }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Title generation failed.' }
    }
  })

  // ── Settings handlers ──────────────────────────────────────────────────

  ipcMain.handle('latch:settings-get', async (_event: any, { key }: any) => {
    if (!settingsStore) return { ok: false, error: 'SettingsStore unavailable' }
    const value = settingsStore.get(key)
    return { ok: true, value }
  })

  ipcMain.handle('latch:settings-set', async (_event: any, { key, value, sensitive }: any) => {
    if (!settingsStore) return { ok: false, error: 'SettingsStore unavailable' }
    settingsStore.set(key, value, !!sensitive)
    return { ok: true }
  })

  ipcMain.handle('latch:settings-delete', async (_event: any, { key }: any) => {
    if (!settingsStore) return { ok: false, error: 'SettingsStore unavailable' }
    settingsStore.delete(key)
    return { ok: true }
  })

  ipcMain.handle('latch:settings-has', async (_event: any, { key }: any) => {
    if (!settingsStore) return { ok: false, error: 'SettingsStore unavailable' }
    const result = settingsStore.has(key)
    return { ok: true, ...result }
  })

  // ── Skills handlers ─────────────────────────────────────────────────────

  ipcMain.handle('latch:skills-list', async () => {
    return skillsStore.listSkills()
  })

  ipcMain.handle('latch:skills-get', async (_event: any, { id }: any) => {
    return skillsStore.getSkill(id)
  })

  ipcMain.handle('latch:skills-save', async (_event: any, skill: any) => {
    return skillsStore.saveSkill(skill)
  })

  ipcMain.handle('latch:skills-delete', async (_event: any, { id }: any) => {
    return skillsStore.deleteSkill(id)
  })

  ipcMain.handle('latch:skills-sync', async (_event: any, { harnessId }: any) => {
    return skillsStore.syncToHarness(harnessId)
  })

  // ── MCP handlers ──────────────────────────────────────────────────────

  ipcMain.handle('latch:mcp-list', async () => {
    return mcpStore.listServers()
  })

  ipcMain.handle('latch:mcp-get', async (_event: any, { id }: any) => {
    return mcpStore.getServer(id)
  })

  ipcMain.handle('latch:mcp-save', async (_event: any, server: any) => {
    return mcpStore.saveServer(server)
  })

  ipcMain.handle('latch:mcp-delete', async (_event: any, { id }: any) => {
    return mcpStore.deleteServer(id)
  })

  ipcMain.handle('latch:mcp-sync', async (_event: any, { harnessId, targetDir }: any) => {
    const { servers } = mcpStore.listServers()
    return syncMcpToHarness(servers ?? [], harnessId, targetDir)
  })

  // ── Activity / Authz handlers ──────────────────────────────────────────

  ipcMain.handle('latch:activity-list', async (_event: any, payload: any = {}) => {
    if (!activityStore) return { ok: false, events: [], total: 0 }
    const result = activityStore.list(payload)
    return { ok: true, ...result }
  })

  ipcMain.handle('latch:activity-clear', async (_event: any, payload: any = {}) => {
    if (!activityStore) return { ok: false }
    activityStore.clear(payload?.sessionId)
    return { ok: true }
  })

  ipcMain.handle('latch:activity-export', async (_event: any, payload: any = {}) => {
    if (!activityStore) return { ok: false, error: 'Activity store unavailable' }
    const format = payload?.format === 'csv' ? 'csv' : 'json'
    const events = activityStore.exportAll(payload?.sessionId)

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Activity Log',
      defaultPath: `latch-activity-${new Date().toISOString().slice(0, 10)}.${format}`,
      filters: format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, error: 'Cancelled' }

    const fs = await import('node:fs/promises')
    if (format === 'csv') {
      const header = 'id,sessionId,timestamp,toolName,actionClass,risk,decision,reason,harnessId'
      const rows = events.map(e =>
        [e.id, e.sessionId, e.timestamp, e.toolName, e.actionClass, e.risk, e.decision, e.reason ?? '', e.harnessId]
          .map(v => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      )
      await fs.writeFile(result.filePath, [header, ...rows].join('\n'), 'utf-8')
    } else {
      await fs.writeFile(result.filePath, JSON.stringify(events, null, 2), 'utf-8')
    }

    return { ok: true, filePath: result.filePath, count: events.length }
  })

  // ── Feed handlers ────────────────────────────────────────────────────

  ipcMain.handle('latch:feed-list', async (_event: any, payload: any = {}) => {
    if (!feedStore) return { ok: false, items: [], total: 0 }
    const result = feedStore.list(payload)
    return { ok: true, ...result }
  })

  ipcMain.handle('latch:feed-clear', async (_event: any, payload: any = {}) => {
    if (!feedStore) return { ok: false }
    feedStore.clear(payload?.sessionId)
    return { ok: true }
  })

  ipcMain.handle('latch:radar-signals', async () => {
    return { ok: true, signals: radar?.getSignals() ?? [] }
  })

  ipcMain.handle('latch:authz-port', async () => {
    return { ok: true, port: authzServer?.getPort() ?? 0 }
  })

  ipcMain.handle('latch:authz-register', async (_event: any, { sessionId, harnessId, policyId, policyOverride }: any) => {
    authzServer?.registerSession(sessionId, harnessId, policyId, policyOverride ?? null)
    return { ok: true, secret: authzServer?.getSecret() ?? null }
  })

  ipcMain.handle('latch:authz-unregister', async (_event: any, { sessionId }: any) => {
    authzServer?.unregisterSession(sessionId)
    return { ok: true }
  })

  ipcMain.handle('latch:authz-secret', async () => {
    return { ok: true, secret: authzServer?.getSecret() ?? null }
  })

  ipcMain.handle('latch:approval-resolve', async (_event: any, { id, decision }: any) => {
    authzServer?.resolveApproval(id, decision)
    return { ok: true }
  })

  // ── Docker handlers ─────────────────────────────────────────────────────

  ipcMain.handle('latch:docker-detect', async () => {
    const result = await dockerManager.detect()
    return { ok: true, ...result }
  })

  ipcMain.handle('latch:docker-pull', async (_event: any, { image }: any) => {
    return dockerManager.pull(image)
  })

  ipcMain.handle('latch:docker-start', async (_event: any, payload: any) => {
    return dockerManager.start(payload.sessionId, payload)
  })

  ipcMain.handle('latch:docker-stop', async (_event: any, { sessionId }: any) => {
    return dockerManager.stop(sessionId)
  })

  ipcMain.handle('latch:docker-status', async (_event: any, { sessionId }: any) => {
    const status = dockerManager.getStatus(sessionId)
    return { ok: true, ...status }
  })

  // ── Project stack detection ────────────────────────────────────────────

  ipcMain.handle('latch:detect-project-stack', async (_event: any, { cwd }: any) => {
    const fs = await import('node:fs')
    const p  = await import('node:path')
    const checks: [string, string][] = [
      ['package.json', 'node'], ['requirements.txt', 'python'],
      ['pyproject.toml', 'python'], ['go.mod', 'go'], ['Cargo.toml', 'rust'],
    ]
    for (const [file, stack] of checks) {
      if (fs.existsSync(p.default.join(cwd, file))) return { ok: true, stack }
    }
    return { ok: true, stack: 'unknown' }
  })

  // ── Directory picker ─────────────────────────────────────────────────

  ipcMain.handle('latch:pick-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select project directory',
    })
    if (result.canceled || !result.filePaths.length) {
      return { cancelled: true }
    }
    return { cancelled: false, filePath: result.filePaths[0] }
  })

  // ── Agents handlers ──────────────────────────────────────────────────

  ipcMain.handle('latch:agents-read', async (_event: any, { dir }: any) => {
    const fs = await import('node:fs/promises')
    const p = await import('node:path')
    const candidates = ['AGENTS.md', 'agents.md']
    for (const name of candidates) {
      const filePath = p.default.join(dir, name)
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        return { ok: true, content, filePath, fileName: name }
      } catch {
        // try next candidate
      }
    }
    // No file found — return empty content with default path
    const filePath = p.default.join(dir, 'AGENTS.md')
    return { ok: true, content: '', filePath, fileName: 'AGENTS.md' }
  })

  ipcMain.handle('latch:agents-write', async (_event: any, { filePath, content }: any) => {
    const fs = await import('node:fs/promises')
    try {
      await fs.writeFile(filePath, content, 'utf-8')
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Write failed' }
    }
  })

})

// ─── Cleanup ──────────────────────────────────────────────────────────────────

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ptyManager?.disposeAll()
  dockerManager?.disposeAll()
  authzServer?.stop()
  radar?.stop()
  db?.close()
})
