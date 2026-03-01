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
import type Database from 'better-sqlite3'

// Local modules — these are JS files imported as ESM so Vite will bundle them.
import {
  getGitRoot,
  createWorktree,
  listWorktrees,
  removeWorktree,
  getWorkspaceRoot,
  getBranchPrefix
} from './lib/git-workspaces'
import { detectAllHarnesses }                   from './lib/harnesses'
import SessionStore                              from './stores/session-store'
import { PolicyStore }                           from './stores/policy-store'
import { enforcePolicy }                         from './services/policy-enforcer'
import { generatePolicy, generateSessionTitle }  from './services/policy-generator'
import { SkillsStore }                           from './stores/skills-store'
import { McpStore }                              from './stores/mcp-store'
import { syncMcpToHarness }                      from './services/mcp-sync'
import { introspectMcpServer }                   from './services/mcp-introspect'

import PtyManager                                from './lib/pty-manager'
import DockerManager                             from './lib/docker-manager'
import { SandboxManager }                        from './lib/sandbox/sandbox-manager'
import { AuthzServer }                           from './services/authz-server'
import { Supervisor }                            from './services/supervisor'
import { ActivityStore }                         from './stores/activity-store'
import { FeedStore }                            from './stores/feed-store'
import { Radar }                                 from './services/radar'
import { SettingsStore }                         from './stores/settings-store'
import { SecretStore }                           from './stores/secret-store'
import { initTelemetrySDK, bindTelemetrySettings, track } from './services/telemetry'
import {
  validateIpc,
  PtyCreateSchema, PtyWriteSchema, PtyResizeSchema, PtyKillSchema,
  SessionCreateSchema, SessionUpdateSchema,
  PolicySaveSchema, SkillSaveSchema, McpSaveSchema,
  AgentsReadSchema, AgentsWriteSchema,
  SettingsKeySchema, SettingsSetSchema,
  SecretSaveSchema, DockerStartSchema, AuthzRegisterSchema,
} from './lib/ipc-schemas'
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall, getUpdateState } from './services/updater'
import { initDebugLog, closeDebugLog } from './services/debug-log'
import { ServiceStore }                          from './stores/service-store'
import { AttestationStore }                      from './stores/attestation-store'
import { AttestationEngine }                     from './services/attestation'
import { annotatePR }                            from './services/pr-annotator'
import { SERVICE_CATALOG }                       from './lib/service-catalog'
import { DataClassifier }                        from './services/data-classifier'
import { CredentialManager }                     from './services/credential-manager'

// ─── Singletons ───────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow
// Initialised in app.whenReady() — always available inside IPC handlers.
let ptyManager!: PtyManager
let dockerManager!: DockerManager
let sandboxManager!: SandboxManager
let sessionStore!: SessionStore
let policyStore!: PolicyStore
let skillsStore!: SkillsStore
let mcpStore!: McpStore
let db!: Database.Database

// Nullable singletons — may not be available depending on runtime conditions.
let authzServer: AuthzServer | null = null
let supervisor: Supervisor | null = null
let activityStore: ActivityStore | null = null
let feedStore: FeedStore | null = null
let radar: Radar | null = null
let settingsStore: SettingsStore | null = null
let secretStore: SecretStore | null = null
let serviceStore: ServiceStore | null = null
let attestationStore: AttestationStore | null = null
let attestationEngine: AttestationEngine | null = null
let dataClassifier: DataClassifier | null = null
let credentialManager: CredentialManager | null = null

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  // Resolve icon path — electron-builder embeds icons in production,
  // but in dev we load from the build/ directory.
  const iconPath = path.join(__dirname, '../../build/icon.png')

  const win = new BrowserWindow({
    width:           1280,
    height:          820,
    minWidth:        1024,
    minHeight:       640,
    backgroundColor: '#05060a',
    title:           'Latch Desktop',
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon:            iconPath,
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true
    }
  })

  // Set macOS dock icon in dev mode
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath)
  }

  // electron-vite dev mode: load from Vite dev server; production: load built HTML.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())

  // Prevent the renderer from navigating away from the app.
  // All external URLs should use shell.openExternal() via the latch:open-external IPC.
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
    if (allowed && url.startsWith(allowed)) return // Allow Vite HMR in dev
    console.warn('[security] Blocked navigation to:', url)
    event.preventDefault()
  })

  // Block all attempts to open new windows (e.g. target="_blank" links).
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[security] Blocked window.open to:', url)
    return { action: 'deny' }
  })

  if (process.env.LATCH_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}

// ─── Debug logging (captures console.warn/error to file) ────────────────────

initDebugLog()

// ─── Telemetry SDK (must init before app.whenReady) ──────────────────────────

initTelemetrySDK(process.env.LATCH_APTABASE_KEY ?? 'A-US-1996460381')

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  mainWindow = createWindow()

  // Auto-updater — wires events to the renderer via latch:updater-status.
  initUpdater(mainWindow)

  // Shared send function for forwarding events to the renderer.
  const sendToRenderer = (channel: string, payload: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(channel, payload)
  }

  // PTY manager — forwards pty output/exit events to the renderer.
  ptyManager = new PtyManager(sendToRenderer)

  // Docker manager — forwards container status events to the renderer.
  dockerManager = new DockerManager(sendToRenderer)

  // Sandbox manager — unified sandbox backend selection and lifecycle.
  sandboxManager = new SandboxManager(sendToRenderer)

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
    secretStore   = SecretStore.open(db)
    serviceStore  = ServiceStore.open(db)
    attestationStore = AttestationStore.open(db)
    attestationEngine = new AttestationEngine(attestationStore)

    credentialManager = new CredentialManager()
    const openaiKey = settingsStore?.get('openai-api-key') ?? null
    dataClassifier = new DataClassifier(openaiKey)

    // Bind telemetry to settings store (SDK already initialised above)
    bindTelemetrySettings((k) => settingsStore!.get(k))

    // Notifications on PTY exit (task completion)
    ptyManager.onExit((tabId: string) => {
      // Unregister tab from supervisor
      supervisor?.unregisterTab(tabId)

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
    if (secretStore) authzServer.setSecretStore(secretStore)
    authzServer.start().catch((err: unknown) => {
      console.error('Authz server start failed:', err instanceof Error ? err.message : String(err))
      authzServer = null
    })
    radar.start()

    // Start supervisor — terminal-driving policy enforcement.
    // The supervisor watches PTY output for harness permission prompts and
    // types yes/no based on policy decisions queued by the authz server.
    supervisor = new Supervisor(authzServer, ptyManager, sendToRenderer, feedStore)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const unavailable = (name: string) => ({
      ok:    false,
      error: `${name} unavailable: ${errMsg}`
    })
    // Fallback stubs so IPC handlers return errors instead of crashing.
    sessionStore = {
      listSessions:  () => unavailable('SessionStore'),
      createSession: () => unavailable('SessionStore'),
      updateSession: () => unavailable('SessionStore'),
      setOverride:   () => unavailable('SessionStore')
    } as unknown as SessionStore
    policyStore = {
      listPolicies: () => unavailable('PolicyStore'),
      getPolicy:    () => unavailable('PolicyStore'),
      savePolicy:   () => unavailable('PolicyStore'),
      deletePolicy: () => unavailable('PolicyStore')
    } as unknown as PolicyStore
    skillsStore = {
      listSkills:    () => unavailable('SkillsStore'),
      getSkill:      () => unavailable('SkillsStore'),
      saveSkill:     () => unavailable('SkillsStore'),
      deleteSkill:   () => unavailable('SkillsStore'),
      syncToHarness: () => unavailable('SkillsStore')
    } as unknown as SkillsStore
    mcpStore = {
      listServers:  () => unavailable('McpStore'),
      getServer:    () => unavailable('McpStore'),
      saveServer:   () => unavailable('McpStore'),
      deleteServer: () => unavailable('McpStore')
    } as unknown as McpStore
    secretStore = null
  }

  // ── macOS re-activate ───────────────────────────────────────────────────
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  // ── PTY handlers ────────────────────────────────────────────────────────

  ipcMain.handle('latch:pty-create', async (_event, payload) => {
    const v = validateIpc(PtyCreateSchema, payload)
    if (!v.ok) return v
    try {
      // Inject authz secret into PTY env so the renderer never sees it
      const ptyEnv = { ...(v.data.env || {}) }
      if (authzServer) {
        ptyEnv.LATCH_AUTHZ_SECRET = authzServer.getSecret()
      }

      // Inject vault secrets as env vars so agents can use $KEY
      if (secretStore) {
        const secretEnv = secretStore.allKeyValues()
        Object.assign(ptyEnv, secretEnv)
      }

      const record = ptyManager.create(v.data.sessionId, {
        ...v.data,
        env: Object.keys(ptyEnv).length ? ptyEnv : undefined,
        dockerContainerId: v.data.dockerContainerId,
      })

      // Load secret values for terminal output redaction
      if (secretStore) {
        ptyManager.setRedactionValues(v.data.sessionId, secretStore.allValues())
      }

      return { ok: true, pid: record.ptyProcess.pid, cwd: record.cwd, shell: record.shell }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'Failed to start shell.' }
    }
  })

  ipcMain.handle('latch:pty-write', async (_event, payload) => {
    const v = validateIpc(PtyWriteSchema, payload)
    if (!v.ok) return v
    try {
      ptyManager.write(v.data.sessionId, v.data.data)
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'PTY write failed.' }
    }
  })

  ipcMain.handle('latch:pty-resize', async (_event, payload) => {
    const v = validateIpc(PtyResizeSchema, payload)
    if (!v.ok) return v
    try {
      ptyManager.resize(v.data.sessionId, v.data.cols, v.data.rows)
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'PTY resize failed.' }
    }
  })

  ipcMain.handle('latch:pty-kill', async (_event, payload) => {
    const v = validateIpc(PtyKillSchema, payload)
    if (!v.ok) return v
    try {
      ptyManager.kill(v.data.sessionId)
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'PTY kill failed.' }
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
    const v = validateIpc(SessionCreateSchema, payload)
    if (!v.ok) return v
    const result = sessionStore.createSession(v.data)
    track('session_created', { harness: v.data.harness_id ?? '' })
    return result
  })

  ipcMain.handle('latch:session-update', async (_event: any, payload: any) => {
    const v = validateIpc(SessionUpdateSchema, payload)
    if (!v.ok) return v
    return sessionStore.updateSession(v.data.id, v.data.updates)
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
    const v = validateIpc(PolicySaveSchema, policy)
    if (!v.ok) return v
    return policyStore.savePolicy(v.data)
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
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'Policy generation failed.' }
    }
  })

  ipcMain.handle('latch:generate-session-title', async (_event: any, { goal }: any) => {
    try {
      const apiKey = settingsStore?.get('openai-api-key') ?? undefined
      const title = await generateSessionTitle(goal, apiKey)
      return { ok: true, title }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'Title generation failed.' }
    }
  })

  // ── Settings handlers ──────────────────────────────────────────────────

  // Keys the renderer is allowed to read via settings-get.
  // Sensitive keys (API keys, tokens) must never be readable from the renderer.
  const SETTINGS_READ_ALLOWLIST = new Set([
    'sandbox-enabled',
    'default-docker-image',
    'sound-notifications',
    'auto-accept',
    'notifications-enabled',
    'telemetry-enabled',
  ])

  ipcMain.handle('latch:settings-get', async (_event: any, payload: any) => {
    const v = validateIpc(SettingsKeySchema, payload)
    if (!v.ok) return v
    if (!settingsStore) return { ok: false, error: 'SettingsStore unavailable' }
    if (!SETTINGS_READ_ALLOWLIST.has(v.data.key)) return { ok: false, error: `Setting '${v.data.key}' is not readable from the renderer.` }
    const value = settingsStore.get(v.data.key)
    return { ok: true, value }
  })

  ipcMain.handle('latch:settings-set', async (_event: any, payload: any) => {
    const v = validateIpc(SettingsSetSchema, payload)
    if (!v.ok) return v
    if (!settingsStore) return { ok: false, error: 'SettingsStore unavailable' }
    settingsStore.set(v.data.key, v.data.value, !!v.data.sensitive)
    return { ok: true }
  })

  ipcMain.handle('latch:settings-delete', async (_event: any, payload: any) => {
    const v = validateIpc(SettingsKeySchema, payload)
    if (!v.ok) return v
    if (!settingsStore) return { ok: false, error: 'SettingsStore unavailable' }
    settingsStore.delete(v.data.key)
    return { ok: true }
  })

  ipcMain.handle('latch:settings-has', async (_event: any, payload: any) => {
    const v = validateIpc(SettingsKeySchema, payload)
    if (!v.ok) return v
    if (!settingsStore) return { ok: false, error: 'SettingsStore unavailable' }
    const result = settingsStore.has(v.data.key)
    return { ok: true, ...result }
  })

  // ── Secrets (vault) handlers ────────────────────────────────────────────

  ipcMain.handle('latch:secret-list', async (_event: any, payload: any = {}) => {
    if (!secretStore) return { ok: false, secrets: [], error: 'SecretStore unavailable' }
    return secretStore.list(payload?.scope)
  })

  ipcMain.handle('latch:secret-get', async (_event: any, { id }: any) => {
    if (!secretStore) return { ok: false, error: 'SecretStore unavailable' }
    return secretStore.get(id)
  })

  ipcMain.handle('latch:secret-save', async (_event: any, params: any) => {
    if (!secretStore) return { ok: false, error: 'SecretStore unavailable' }
    const v = validateIpc(SecretSaveSchema, params)
    if (!v.ok) return v
    return secretStore.save(v.data)
  })

  ipcMain.handle('latch:secret-delete', async (_event: any, { id }: any) => {
    if (!secretStore) return { ok: false, error: 'SecretStore unavailable' }
    return secretStore.delete(id)
  })

  ipcMain.handle('latch:secret-validate', async (_event: any, { env }: any) => {
    if (!secretStore) return { ok: false, missing: [], error: 'SecretStore unavailable' }
    const { validateSecretRefs } = await import('./services/secret-resolver')
    const missing = validateSecretRefs(env ?? {}, secretStore)
    return { ok: true, missing }
  })

  ipcMain.handle('latch:secret-hints', async () => {
    if (!secretStore) return { ok: false, hints: [], error: 'SecretStore unavailable' }
    return { ok: true, hints: secretStore.listHints() }
  })

  // ── Services (enclave) handlers ─────────────────────────────────────────

  ipcMain.handle('latch:service-list', async () => {
    if (!serviceStore) return { ok: false, services: [] }
    return serviceStore.list()
  })

  ipcMain.handle('latch:service-get', async (_event: any, { id }: any) => {
    if (!serviceStore) return { ok: false, error: 'ServiceStore unavailable' }
    return serviceStore.get(id)
  })

  ipcMain.handle('latch:service-save', async (_event: any, payload: any) => {
    if (!serviceStore) return { ok: false, error: 'ServiceStore unavailable' }
    const result = serviceStore.save(payload.definition)
    if (result.ok && payload.credentialValue && secretStore) {
      const secretKey = `service:${payload.definition.id}`
      secretStore.save({
        id: `svc-${payload.definition.id}`,
        name: `${payload.definition.name} credential`,
        key: secretKey,
        value: payload.credentialValue,
        description: `Auto-managed credential for ${payload.definition.name} service`,
        scope: 'global',
        tags: ['service', payload.definition.id],
      })
      serviceStore.markCredentialStored(payload.definition.id)
    }
    return result
  })

  ipcMain.handle('latch:service-delete', async (_event: any, { id }: any) => {
    if (!serviceStore) return { ok: false }
    if (secretStore) secretStore.delete(`svc-${id}`)
    return serviceStore.delete(id)
  })

  ipcMain.handle('latch:service-catalog', async () => {
    return { ok: true, catalog: SERVICE_CATALOG }
  })

  // ── Attestation handlers ──────────────────────────────────────────────

  ipcMain.handle('latch:attestation-get', async (_event: any, { sessionId }: any) => {
    if (!attestationStore) return { ok: false, error: 'AttestationStore unavailable' }
    const receipt = attestationStore.getReceipt(sessionId)
    if (!receipt) return { ok: false, error: 'No attestation receipt for this session' }
    return { ok: true, receipt }
  })

  ipcMain.handle('latch:attestation-audit-log', async (_event: any, { sessionId, limit }: any) => {
    if (!attestationStore) return { ok: false, events: [] }
    return { ok: true, events: attestationStore.listEvents(sessionId, limit) }
  })

  ipcMain.handle('latch:attestation-inclusion-proof', async (_event: any, { sessionId, eventId }: any) => {
    if (!attestationEngine) return { ok: false, error: 'AttestationEngine unavailable' }
    const proof = attestationEngine.generateInclusionProof(sessionId, eventId)
    if (!proof) return { ok: false, error: 'Event not found or no audit log' }
    return { ok: true, proof }
  })

  ipcMain.handle('latch:attestation-annotate-pr', async (_event: any, { sessionId, prUrl }: any) => {
    if (!attestationStore) return { ok: false, error: 'AttestationStore unavailable' }
    const receipt = attestationStore.getReceipt(sessionId)
    if (!receipt) return { ok: false, error: 'No receipt for this session' }

    // Get GitHub token from secrets store
    const token = secretStore?.resolve('service:github')
    if (!token) return { ok: false, error: 'No GitHub credential configured' }

    return annotatePR(receipt, prUrl, token)
  })

  // ── Data classification & credential lifecycle ────────────────────────

  ipcMain.handle('latch:data-classify', async (_event: any, { body, service, contentType }: any) => {
    if (!dataClassifier) return { ok: false, error: 'DataClassifier unavailable' }
    const classification = await dataClassifier.classify(body, service, contentType)
    if (!classification) return { ok: false, error: 'Classification failed or no API key' }
    return { ok: true, classification }
  })

  ipcMain.handle('latch:credential-refresh', async (_event: any, { serviceId }: any) => {
    if (!credentialManager || !serviceStore) return { ok: false, error: 'Unavailable' }
    const result = serviceStore.get(serviceId)
    if (!result.ok || !result.service) return { ok: false, error: 'Service not found' }
    if (!secretStore) return { ok: false, error: 'SecretStore unavailable' }
    const credValue = secretStore.resolve(`service:${serviceId}`)
    if (!credValue) return { ok: false, error: 'No credential stored' }
    let creds: Record<string, string>
    try { creds = JSON.parse(credValue) } catch { return { ok: false, error: 'Invalid credential format' } }
    const validation = await credentialManager.validateCredential(result.service.definition, creds)
    return { ok: true, valid: validation.valid, status: validation.status }
  })

  ipcMain.handle('latch:credential-status', async (_event: any, { serviceId }: any) => {
    if (!credentialManager) return { ok: false, expired: false, expiresAt: null, lastValidated: null }
    const status = credentialManager.getStatus(serviceId)
    return { ok: true, expired: status.expired, expiresAt: null, lastValidated: status.lastValidated }
  })

  // ── Skills handlers ─────────────────────────────────────────────────────

  ipcMain.handle('latch:skills-list', async () => {
    return skillsStore.listSkills()
  })

  ipcMain.handle('latch:skills-get', async (_event: any, { id }: any) => {
    return skillsStore.getSkill(id)
  })

  ipcMain.handle('latch:skills-save', async (_event: any, skill: any) => {
    const v = validateIpc(SkillSaveSchema, skill)
    if (!v.ok) return v
    return skillsStore.saveSkill(v.data)
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
    const v = validateIpc(McpSaveSchema, server)
    if (!v.ok) return v
    return mcpStore.saveServer(v.data)
  })

  ipcMain.handle('latch:mcp-delete', async (_event: any, { id }: any) => {
    return mcpStore.deleteServer(id)
  })

  ipcMain.handle('latch:mcp-sync', async (_event: any, { harnessId, targetDir }: any) => {
    const { servers } = mcpStore.listServers()
    const secretCtx = authzServer && secretStore
      ? { authzUrl: `http://127.0.0.1:${authzServer.getPort()}`, authzSecret: authzServer.getSecret() }
      : null
    return syncMcpToHarness(servers ?? [], harnessId, targetDir, secretCtx)
  })

  ipcMain.handle('latch:mcp-introspect', async (_event: any, { id }: any) => {
    const result = mcpStore.getServer(id)
    if (!result.ok || !result.server) return { ok: false, error: result.error ?? 'Server not found.' }
    return introspectMcpServer(result.server, secretStore)
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

  ipcMain.handle('latch:authz-register', async (_event: any, payload: any) => {
    const v = validateIpc(AuthzRegisterSchema, payload)
    if (!v.ok) return v
    authzServer?.registerSession(v.data.sessionId, v.data.harnessId, v.data.policyId, v.data.policyOverride ?? null)
    return { ok: true }
  })

  ipcMain.handle('latch:authz-unregister', async (_event: any, { sessionId }: any) => {
    authzServer?.unregisterSession(sessionId)
    return { ok: true }
  })

  ipcMain.handle('latch:approval-resolve', async (_event: any, { id, decision }: any) => {
    // Try supervisor first (handles escalated prompt decisions for Claude sessions).
    // Falls through to authzServer for Codex/OpenClaw's ApprovalBar flow.
    supervisor?.resolveDecision(id, decision)
    authzServer?.resolveApproval(id, decision)
    return { ok: true }
  })

  // ── Supervisor handlers ─────────────────────────────────────────────────

  ipcMain.handle('latch:supervisor-register-tab', async (_event: any, payload: any) => {
    const { tabId, sessionId, harnessId } = payload ?? {}
    if (!tabId || !sessionId) return { ok: false, error: 'Missing tabId or sessionId' }
    supervisor?.registerTab(tabId, sessionId, harnessId ?? 'claude')
    return { ok: true }
  })

  // ── Docker handlers ─────────────────────────────────────────────────────

  ipcMain.handle('latch:docker-detect', async () => {
    const result = await dockerManager.detect()
    if (result.available) dockerManager.cleanupOrphaned()
    return { ok: true, ...result }
  })

  ipcMain.handle('latch:docker-pull', async (_event: any, { image }: any) => {
    return dockerManager.pull(image)
  })

  ipcMain.handle('latch:docker-start', async (_event: any, payload: any) => {
    const v = validateIpc(DockerStartSchema, payload)
    if (!v.ok) return v
    return dockerManager.start(v.data.sessionId, v.data)
  })

  ipcMain.handle('latch:docker-stop', async (_event: any, { sessionId }: any) => {
    return dockerManager.stop(sessionId)
  })

  ipcMain.handle('latch:docker-status', async (_event: any, { sessionId }: any) => {
    const status = dockerManager.getStatus(sessionId)
    return { ok: true, ...status }
  })

  // ── Sandbox handlers ───────────────────────────────────────────────────

  ipcMain.handle('latch:sandbox-detect', async () => {
    try {
      const backends = await sandboxManager.getAvailableBackends()
      const best = await sandboxManager.detectBestBackend()
      return { ok: true, backends, best: best.backend }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), backends: {}, best: null }
    }
  })

  ipcMain.handle('latch:sandbox-status', async (_event: any, { sessionId }: any) => {
    const status = sandboxManager.getSessionStatus(sessionId)
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

  // ── Updater handlers ─────────────────────────────────────────────────

  ipcMain.handle('latch:updater-check', async () => {
    const state = await checkForUpdates()
    return { ok: true, ...state }
  })

  ipcMain.handle('latch:updater-download', async () => {
    const state = await downloadUpdate()
    return { ok: true, ...state }
  })

  ipcMain.handle('latch:updater-install', async () => {
    quitAndInstall()
    return { ok: true }
  })

  ipcMain.handle('latch:updater-state', async () => {
    return { ok: true, ...getUpdateState() }
  })

  // ── Agents handlers ──────────────────────────────────────────────────

  ipcMain.handle('latch:agents-read', async (_event: any, payload: any) => {
    const v = validateIpc(AgentsReadSchema, payload)
    if (!v.ok) return { ...v, content: '', filePath: '', fileName: '' }
    const fs = await import('node:fs/promises')
    const p = await import('node:path')
    const homeDir = await import('node:os').then((os) => os.homedir())

    // Path traversal guard: dir must resolve within the user's home directory
    const resolvedDir = p.default.resolve(v.data.dir)
    if (!resolvedDir.startsWith(homeDir)) {
      return { ok: false, error: 'Directory must be within the user home directory.', content: '', filePath: '', fileName: '' }
    }

    const candidates = ['AGENTS.md', 'agents.md']
    for (const name of candidates) {
      const filePath = p.default.join(resolvedDir, name)
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        return { ok: true, content, filePath, fileName: name }
      } catch {
        // try next candidate
      }
    }
    // No file found — return empty content with default path
    const filePath = p.default.join(resolvedDir, 'AGENTS.md')
    return { ok: true, content: '', filePath, fileName: 'AGENTS.md' }
  })

  ipcMain.handle('latch:agents-write', async (_event: any, payload: any) => {
    const v = validateIpc(AgentsWriteSchema, payload)
    if (!v.ok) return v
    const fs = await import('node:fs/promises')
    const p = await import('node:path')
    const homeDir = await import('node:os').then((os) => os.homedir())

    // Path traversal guard: must be within home dir and must be an AGENTS.md file
    const resolved = p.default.resolve(v.data.filePath)
    const basename = p.default.basename(resolved).toLowerCase()
    if (!resolved.startsWith(homeDir)) {
      return { ok: false, error: 'File path must be within the user home directory.' }
    }
    if (basename !== 'agents.md') {
      return { ok: false, error: 'Only AGENTS.md files can be written.' }
    }

    try {
      await fs.writeFile(resolved, v.data.content, 'utf-8')
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'Write failed' }
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
  sandboxManager?.disposeAll()
  authzServer?.stop()
  radar?.stop()
  db?.close()
  closeDebugLog()
})
