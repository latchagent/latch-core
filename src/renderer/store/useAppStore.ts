/**
 * @module useAppStore
 * @description Central Zustand store for Latch Desktop renderer state.
 *
 * Manages sessions, tabs, harnesses, rail panel selection, and modal state.
 * Terminal (xterm.js) instances live in `TerminalManager` outside this store
 * because they are imperative objects unsuitable for reactive state.
 */

import { create } from 'zustand';
import type {
  SessionRecord,
  TabRecord,
  HarnessRecord,
  PolicyDocument,
  SkillRecord,
  McpServerRecord,
  SecretRecord,
  ServiceRecord,
  ServiceDefinition,
  AgentStatus,

  RailPanel,
  AppView,
  DockerConfig,
  DockerStatus,
  GatewayConfig,
  ActivityEvent,
  RadarSignal,
  PendingApproval,
  ApprovalDecision,
  FeedItem,
} from '../../types';
import { terminalManager } from '../terminal/TerminalManager';
import type { CatalogSkill } from '../data/skill-catalog';
import type { CatalogMcpServer } from '../data/mcp-catalog';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let sessionCounter = 0;
let tabCounter     = 0;

/** Apply theme class to document root and update terminal themes. */
let systemThemeQuery: MediaQueryList | null = null;
let systemThemeHandler: ((e: MediaQueryListEvent) => void) | null = null;

function applyTheme(theme: 'dark' | 'light' | 'system'): void {
  // Tear down previous system listener
  if (systemThemeHandler && systemThemeQuery) {
    systemThemeQuery.removeEventListener('change', systemThemeHandler);
    systemThemeHandler = null;
  }

  const root = document.documentElement;
  root.classList.remove('theme-dark', 'theme-light');
  if (theme === 'system') {
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (prefersDark: boolean) => {
      root.classList.remove('theme-dark', 'theme-light');
      root.classList.add(prefersDark ? 'theme-dark' : 'theme-light');
      terminalManager.updateTheme();
    };
    apply(systemThemeQuery.matches);
    systemThemeHandler = (e) => apply(e.matches);
    systemThemeQuery.addEventListener('change', systemThemeHandler);
  } else {
    root.classList.add(`theme-${theme}`);
  }
  terminalManager.updateTheme();
}

// ─── Agent-status idle timer ─────────────────────────────────────────────────

const ACTIVITY_RUNNING_THRESHOLD_MS = 8_000;
const NEEDS_INPUT_THRESHOLD_MS = 30_000;
let statusIntervalId: ReturnType<typeof setInterval> | null = null;

/** Start the idle-check interval on the first activity event. */
function ensureStatusInterval(): void {
  if (statusIntervalId) return;
  statusIntervalId = setInterval(() => {
    const { lastActivityTs } = useAppStore.getState();
    const now = Date.now();
    let needsTick = false;
    lastActivityTs.forEach((ts) => {
      // Tick while sessions are running OR transitioning to needs-input
      if (now - ts < NEEDS_INPUT_THRESHOLD_MS) needsTick = true;
    });
    if (needsTick) {
      useAppStore.setState((s) => ({ _statusTick: s._statusTick + 1 }));
    }
  }, 2_000);
}

function nextTabId():     string { return `tab-${++tabCounter}`; }
function nextSessionId(): string { return `session-${++sessionCounter}`; }

function inferHarnessLabel(harnessId: string | null): string {
  if (!harnessId) return 'Shell';
  const map: Record<string, string> = {
    claude:   'Claude Code',
    codex:    'Codex',
    openclaw: 'OpenClaw',
    droid:    'Droid',
    opencode: 'OpenCode',
  };
  return map[harnessId] ?? harnessId;
}

function makeTab(sessionId: string, label: string): TabRecord {
  return {
    id: nextTabId(),
    sessionId,
    label,
    ptyReady:       false,
    needsReconnect: false,
  };
}

// ─── Store interface ──────────────────────────────────────────────────────────

export interface AppState {
  // ── Data ────────────────────────────────────────────────────────────────────
  sessions:         Map<string, SessionRecord>;
  activeSessionId:  string | null;
  harnesses:        HarnessRecord[];
  harnessesLoaded:  boolean;
  activeRailPanel:  RailPanel;
  activeView:       AppView;
  pendingProjectDir: string | null;

  // ── Policy rail ──────────────────────────────────────────────────────────────
  policies:         PolicyDocument[];
  policiesLoaded:   boolean;
  activePolicyDoc:  PolicyDocument | null;

  // ── Skills rail ──────────────────────────────────────────────────────────────
  skills:           SkillRecord[];

  // ── MCP Servers ────────────────────────────────────────────────────────────
  mcpServers:       McpServerRecord[];

  // ── Secrets (internal storage) ──────────────────────────────────────────────
  secrets:                SecretRecord[];

  // ── Services (gateway) ─────────────────────────────────────────────────────
  services:         ServiceRecord[];
  serviceCatalog:   ServiceDefinition[];
  servicesLoaded:   boolean;

  // ── Docker ───────────────────────────────────────────────────────────────────
  dockerAvailable: boolean;
  sandboxEnabled: boolean;
  defaultDockerImage: string;

  // ── Activity ────────────────────────────────────────────────────────────────
  activityEvents: ActivityEvent[];
  activityTotal:  number;
  radarSignals:   RadarSignal[];

  // ── Feed ──────────────────────────────────────────────────────────────────
  feedItems: FeedItem[];
  feedUnread: number;
  soundNotifications: boolean;
  theme: 'dark' | 'light' | 'system';

  // ── Approvals ──────────────────────────────────────────────────────────────
  pendingApprovals: PendingApproval[];

  // ── Agent status ───────────────────────────────────────────────────────────
  /** Epoch ms of the last activity event per session — used for running/idle. */
  lastActivityTs: Map<string, number>;
  /** Generation counter bumped by the idle-check timer to trigger re-renders. */
  _statusTick: number;

  // ── Agents ──────────────────────────────────────────────────────────────────
  agentsContent:   string;
  agentsFilePath:  string | null;
  agentsFileName:  string | null;
  agentsLoading:   boolean;
  agentsDirty:     boolean;
  defaultHarnessId: string | null;

  // ── Policy generation ──────────────────────────────────────────────────────
  policyGenerating: boolean;

  // ── Loading state ────────────────────────────────────────────────────────────
  sessionFinalizing: boolean;
  appBooting:        boolean;

  // ── Modal state ──────────────────────────────────────────────────────────────
  // Session wizard state lives on session.showWizard (see SessionRecord).
  policyEditorIsOverride: boolean;
  policyEditorPolicy:     PolicyDocument | null;
  skillEditorOpen:        boolean;
  skillEditorSkill:       SkillRecord | null;
  skillDetailOpen:        boolean;
  skillDetailSkill:       CatalogSkill | SkillRecord | null;
  skillInstallFlash:      string | null;
  mcpEditorOpen:          boolean;
  mcpEditorServer:        McpServerRecord | null;
  mcpDetailOpen:          boolean;
  mcpDetailServer:        CatalogMcpServer | McpServerRecord | null;
  mcpInstallFlash:        string | null;
  // ── Actions ──────────────────────────────────────────────────────────────────

  // Harnesses
  loadHarnesses: () => Promise<void>;

  // Sessions
  loadSessions:    () => Promise<void>;
  createSession:   (name: string) => string;
  deleteSession:   (id: string) => Promise<void>;
  activateSession: (id: string) => void;
  finalizeSession: (sessionId: string, opts: { skipWorktree: boolean; goal?: string; branchName?: string; projectDir?: string; mcpServerIds?: string[] }) => Promise<void>;

  // Tabs
  activateTab: (sessionId: string, tabId: string) => void;
  closeTab:    (sessionId: string, tabId: string) => void;
  addTab:      (sessionId: string, label?: string) => TabRecord;
  renameTab:   (sessionId: string, tabId: string, label: string) => void;
  setTabPtyReady: (tabId: string, ready: boolean) => void;

  // Views
  setActiveView:      (view: AppView) => void;
  setPendingProjectDir: (dir: string | null) => void;

  // Rail
  setActiveRailPanel: (panel: RailPanel) => void;

  // Policy
  loadPolicies:     () => Promise<void>;
  loadPolicyPanel:  () => Promise<void>;
  openPolicyEditor: (policy: PolicyDocument | null, isOverride: boolean) => void;
  closePolicyEditor: () => void;
  savePolicyFromEditor: (policy: PolicyDocument) => Promise<void>;
  clearSessionOverride: () => Promise<void>;

  // Skills
  loadSkills: () => Promise<void>;
  openSkillEditor:  (skill: SkillRecord | null) => void;
  closeSkillEditor: () => void;
  openSkillDetail:  (skill: CatalogSkill | SkillRecord) => void;
  closeSkillDetail: () => void;
  saveSkill:        (skill: SkillRecord) => Promise<void>;
  deleteSkill:      (id: string) => Promise<void>;

  // MCP Servers
  loadMcpServers:   () => Promise<void>;
  openMcpEditor:    (server: McpServerRecord | null) => void;
  closeMcpEditor:   () => void;
  openMcpDetail:    (server: CatalogMcpServer | McpServerRecord) => void;
  closeMcpDetail:   () => void;
  saveMcpServer:    (server: McpServerRecord) => Promise<void>;
  deleteMcpServer:  (id: string) => Promise<void>;
  introspectMcpServer: (id: string) => Promise<{ ok: boolean; tools?: { name: string; description: string }[]; error?: string }>;

  // Secrets (internal)
  loadSecrets:        () => Promise<void>;

  // Services (gateway)
  loadServices:   () => Promise<void>;
  saveService:    (definition: ServiceDefinition, credentialValue?: string) => Promise<{ ok: boolean; error?: string }>;
  deleteService:  (id: string) => Promise<{ ok: boolean }>;

  // Docker
  detectDocker:         () => Promise<void>;
  handleDockerStatus:   (sessionId: string, status: DockerStatus) => void;
  setSandboxEnabled:    (enabled: boolean) => Promise<void>;
  setDefaultDockerImage: (image: string) => Promise<void>;
  loadSandboxSettings:  () => Promise<void>;

  // Agents
  loadAgentsPanel:  () => Promise<void>;
  saveAgents:       (content: string) => Promise<void>;
  setDefaultHarnessId: (id: string | null) => void;

  // Policy generation
  generatePolicy:   (prompt: string) => Promise<void>;

  // Activity
  loadActivityPanel:    () => Promise<void>;
  clearActivity:        () => Promise<void>;
  handleActivityEvent:  (event: ActivityEvent) => void;
  handleRadarSignal:    (signal: RadarSignal) => void;

  // Feed
  loadFeed:          () => Promise<void>;
  handleFeedUpdate:  (item: FeedItem) => void;
  clearFeed:         () => Promise<void>;
  loadSoundSetting:  () => Promise<void>;
  loadThemeSetting:  () => Promise<void>;
  setTheme:          (theme: 'dark' | 'light' | 'system') => Promise<void>;

  // Approvals
  handleApprovalRequest:  (approval: PendingApproval) => void;
  handleApprovalResolved: (payload: { id: string }) => void;
  resolveApproval:        (id: string, decision: ApprovalDecision) => Promise<void>;

  // PTY helpers (called from PTY event handlers in App.tsx)
  handlePtyData: (tabId: string, data: string) => void;
  handlePtyExit: (tabId: string) => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>((set, get) => ({

  // ── Initial state ────────────────────────────────────────────────────────────

  sessions:         new Map(),
  activeSessionId:  null,
  harnesses:        [],
  harnessesLoaded:  false,
  activeRailPanel:  'activity',
  activeView:       'home',
  pendingProjectDir: null,
  policies:         [],
  policiesLoaded:   false,
  activePolicyDoc:  null,
  skills:           [],
  mcpServers:       [],
  secrets:                [],
  services:               [],
  serviceCatalog:         [],
  servicesLoaded:         false,
  dockerAvailable:  false,
  sandboxEnabled:   true,
  defaultDockerImage: 'node:20',
  activityEvents:   [],
  activityTotal:    0,
  radarSignals:     [],
  feedItems:           [],
  feedUnread:          0,
  soundNotifications:  true,
  theme:               'dark',
  pendingApprovals: [],
  lastActivityTs:   new Map(),
  _statusTick:      0,
  agentsContent:    '',
  agentsFilePath:   null,
  agentsFileName:   null,
  agentsLoading:    false,
  agentsDirty:      false,
  defaultHarnessId: null,
  policyGenerating: false,
  policyEditorIsOverride: false,
  policyEditorPolicy:     null,
  skillEditorOpen:  false,
  skillEditorSkill: null,
  skillDetailOpen:  false,
  skillDetailSkill: null,
  skillInstallFlash: null,
  mcpEditorOpen:     false,
  mcpEditorServer:   null,
  mcpDetailOpen:     false,
  mcpDetailServer:   null,
  mcpInstallFlash:   null,
  appBooting:          true,
  sessionFinalizing:   false,

  // ── Harnesses ────────────────────────────────────────────────────────────────

  loadHarnesses: async () => {
    if (!window.latch?.detectHarnesses) {
      set({ harnesses: [], harnessesLoaded: true });
      return;
    }
    try {
      const result = await window.latch.detectHarnesses();
      set({ harnesses: result?.harnesses ?? [], harnessesLoaded: true });
    } catch {
      set({ harnesses: [], harnessesLoaded: true });
    }
  },

  // ── Sessions ─────────────────────────────────────────────────────────────────

  loadSessions: async () => {
    if (!window.latch?.listSessionRecords) return;

    const result = await window.latch.listSessionRecords();
    const rows   = result?.sessions ?? [];
    if (!rows.length) return;

    const sessions = new Map<string, SessionRecord>();

    rows.forEach((row: any) => {
      const num = parseInt(String(row.id).replace('session-', ''), 10);
      if (!isNaN(num)) sessionCounter = Math.max(sessionCounter, num);

      const harnessLabel = inferHarnessLabel(row.harness_id);
      const tab = makeTab(row.id, harnessLabel);
      tab.needsReconnect = true;

      const tabs = new Map<string, TabRecord>();
      tabs.set(tab.id, tab);

      const session: SessionRecord = {
        id:            row.id,
        name:          row.name,
        harness:       harnessLabel,
        harnessId:     row.harness_id || null,
        harnessCommand: row.harness_command || null,
        policy:        row.policy_set || 'Default',
        policyId:      row.policy_set || 'default',
        policyOverride: (() => { try { return row.policy_override ? JSON.parse(row.policy_override) : null } catch { return null } })(),
        projectDir:    row.project_dir || null,
        repoRoot:      row.repo_root || null,
        worktreePath:  row.worktree_path || null,
        branchRef:     row.branch_ref || null,
        goal:          row.goal || '',
        branchName:    '',
        docker:        (() => { try { return row.docker_config ? JSON.parse(row.docker_config) : null } catch { return null } })(),
        gateway:       (() => { try { return row.enclave_config ? JSON.parse(row.enclave_config) : null } catch { return null } })(),
        tabs,
        activeTabId:   tab.id,
        needsReconnect: true,
        showWizard:    false,
      };

      sessions.set(row.id, session);
    });

    set({ sessions });

    const firstId = sessions.keys().next().value;
    if (firstId) get().activateSession(firstId);
  },

  createSession: (name: string): string => {
    const id  = nextSessionId();
    const tab = makeTab(id, 'Shell');
    const tabs = new Map<string, TabRecord>();
    tabs.set(tab.id, tab);

    const session: SessionRecord = {
      id, name,
      harness:       'Latch',
      harnessId:     null,
      harnessCommand: null,
      policy:        'None',
      policyId:      '',
      policyOverride: null,
      projectDir:    null,
      repoRoot:      null,
      worktreePath:  null,
      branchRef:     null,
      goal:          '',
      branchName:    '',
      docker:        null,
      gateway:       null,
      tabs,
      activeTabId:   tab.id,
      needsReconnect: false,
      showWizard:    true,
    };

    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(id, session);
      return { sessions };
    });

    get().activateSession(id);
    return id;
  },

  activateSession: (id: string) => {
    const session = get().sessions.get(id);
    if (!session) return;

    set({ activeSessionId: id, activeView: 'home' });

    // Refresh policy panel when session changes
    get().loadPolicyPanel();
  },

  deleteSession: async (id: string) => {
    const session = get().sessions.get(id);
    if (!session) return;

    // Stop gateway if running
    if (session.gateway?.enabled && window.latch?.stopGateway) {
      await window.latch.stopGateway({ sessionId: id, exitReason: 'normal' })
    }

    // Kill all PTYs and unmount all terminals for this session
    for (const tab of session.tabs.values()) {
      if (tab.ptyReady) window.latch?.killPty?.({ sessionId: tab.id });
      terminalManager.unmount(tab.id);
    }

    // Unregister from authz server
    window.latch?.authzUnregister?.({ sessionId: id });

    // Stop Docker container if running
    if (session.docker?.containerId) {
      window.latch?.dockerStop?.({ sessionId: id });
    }

    // Remove worktree if one was created
    if (session.worktreePath) {
      window.latch?.removeWorktree?.({ worktreePath: session.worktreePath });
    }

    // Delete from SQLite
    window.latch?.deleteSessionRecord?.({ id });

    // Remove from store and switch to another session
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.delete(id);
      const lastActivityTs = new Map(s.lastActivityTs);
      lastActivityTs.delete(id);
      let activeSessionId = s.activeSessionId;
      if (activeSessionId === id) {
        activeSessionId = sessions.size > 0 ? sessions.keys().next().value! : null;
      }
      return { sessions, activeSessionId, lastActivityTs };
    });

    // Refresh panels for the new active session
    const newActive = get().activeSessionId;
    if (newActive) {
      get().loadPolicyPanel();
    }
  },

  finalizeSession: async (sessionId, { skipWorktree, goal, branchName, projectDir, mcpServerIds }) => {
    set({ sessionFinalizing: true });
    try {
    const sessions = new Map(get().sessions);
    const orig     = sessions.get(sessionId);
    if (!orig) return;

    // Apply wizard inputs immutably
    const session = { ...orig };
    if (goal       !== undefined) session.goal       = goal;
    if (branchName !== undefined) session.branchName = branchName;
    if (projectDir !== undefined) session.projectDir = projectDir;

    // Generate a descriptive session title from the goal (async, non-blocking).
    // We capture a promise so we can persist the title after the DB record exists.
    let generatedTitle: string | null = null;
    const titlePromise = (goal && window.latch?.generateSessionTitle)
      ? window.latch.generateSessionTitle({ goal }).then((result) => {
          if (result?.ok && result.title) {
            generatedTitle = result.title;
            set((s) => {
              const sessions = new Map(s.sessions);
              const sess = sessions.get(sessionId);
              if (sess) sessions.set(sessionId, { ...sess, name: result.title! });
              return { sessions };
            });
          }
        }).catch(() => { /* title gen is best-effort */ })
      : null;

    // Fill harness if blank
    if (!session.harnessId) {
      const fb = get().harnesses.find((h) => h.installed);
      if (fb) {
        session.harnessId      = fb.id;
        session.harness        = fb.label;
        session.harnessCommand = fb.recommendedCommand;
      }
    }

    session.showWizard = false;
    sessions.set(sessionId, session);
    set({ sessions });

    const tab   = session.tabs.get(session.activeTabId)!;
    const tabId = tab.id;

    // Update tab label with harness name — prefix with ✦ to mark the agent tab
    const updatedTab = { ...tab, label: `✦ ${session.harness || 'Shell'}` };
    const updatedTabs = new Map(session.tabs);
    updatedTabs.set(tabId, updatedTab);
    const updatedSession = { ...session, tabs: updatedTabs };
    sessions.set(sessionId, updatedSession);
    set({ sessions: new Map(sessions) });

    // Write context to terminal
    terminalManager.writeln(tabId, 'latch> new');
    if (session.goal)       terminalManager.writeln(tabId, `Goal: ${session.goal}`);
    if (session.branchName) terminalManager.writeln(tabId, `Branch: ${session.branchName}`);
    if (session.harness)    terminalManager.writeln(tabId, `Harness: ${session.harness}`);

    // Print available secrets so agents know which env vars they can use
    if (window.latch?.listSecretHints) {
      const hintsResult = await window.latch.listSecretHints();
      if (hintsResult?.ok && hintsResult.hints?.length > 0) {
        terminalManager.writeln(tabId, '');
        terminalManager.writeln(tabId, '\x1b[2mAvailable secrets (injected as env vars):\x1b[0m');
        for (const hint of hintsResult.hints) {
          const desc = hint.description ? ` \x1b[2m\u2014 ${hint.description}\x1b[0m` : '';
          terminalManager.writeln(tabId, `\x1b[2m  $${hint.key}${desc}\x1b[0m`);
        }
      }
    }

    let repoRoot:    string | null = null;
    let worktreePath: string | null = null;
    let branchRef:   string | null = null;

    if (!skipWorktree && window.latch?.getGitStatus) {
      const status = await window.latch.getGitStatus(projectDir ? { cwd: projectDir } : undefined);
      if (status?.isRepo) {
        repoRoot = status.root;
        terminalManager.writeln(tabId, `Git root: ${repoRoot}`);

        const wt = await window.latch.createWorktree({
          repoPath: repoRoot!, branchName: session.branchName, sessionName: session.name
        });
        if (wt?.ok) {
          worktreePath = wt.workspacePath ?? null;
          branchRef    = wt.branchRef    ?? null;
          terminalManager.writeln(tabId, `Worktree: ${worktreePath}`);
          terminalManager.writeln(tabId, `Branch: ${branchRef}`);
        } else {
          terminalManager.writeln(tabId, `Worktree skipped: ${wt?.error ?? 'unknown error'}`);
        }
      } else {
        terminalManager.writeln(tabId, 'No Git repo detected — starting without worktree.');
      }
    }

    const cwd = worktreePath ?? repoRoot ?? projectDir ?? undefined;

    // ── Docker sandbox setup ──────────────────────────────────────────────
    let dockerContainerId: string | undefined;

    if (session.docker?.enabled && window.latch?.dockerPull && window.latch?.dockerStart) {
      const dockerImage = session.docker.image;
      terminalManager.writeln(tabId, `\x1b[2mDocker: pulling ${dockerImage}...\x1b[0m`);

      const pullResult = await window.latch.dockerPull({ image: dockerImage });
      if (pullResult?.ok) {
        terminalManager.writeln(tabId, `\x1b[2mDocker: image ready.\x1b[0m`);
      } else {
        terminalManager.writeln(tabId, `\x1b[1;33m⚠ SANDBOX UNAVAILABLE\x1b[0m`);
        terminalManager.writeln(tabId, `\x1b[33mDocker pull failed: ${pullResult?.error ?? 'unknown'}\x1b[0m`);
        terminalManager.writeln(tabId, `\x1b[33mThis session is running WITHOUT sandbox isolation.\x1b[0m`);
        terminalManager.writeln(tabId, '');
      }

      if (pullResult?.ok) {
        terminalManager.writeln(tabId, `\x1b[2mDocker: starting container...\x1b[0m`);

        // Check network policy
        const policyDoc = get().activePolicyDoc;
        const networkEnabled = policyDoc?.permissions?.allowNetwork ?? true;

        const startResult = await window.latch.dockerStart({
          sessionId,
          image: dockerImage,
          workspacePath: cwd,
          networkEnabled,
          ports: session.docker.ports,
          extraVolumes: session.docker.extraVolumes,
        });

        if (startResult?.ok && startResult.containerId) {
          dockerContainerId = startResult.containerId;
          if (session.harnessCommand) {
            terminalManager.writeln(tabId, `\x1b[32mDocker: container ${dockerContainerId} running (workspace isolation).\x1b[0m`);
          } else {
            terminalManager.writeln(tabId, `\x1b[32mDocker: container ${dockerContainerId} running.\x1b[0m`);
          }

          // Update session state with container ID
          set((s) => {
            const sessions = new Map(s.sessions);
            const sess = sessions.get(sessionId);
            if (sess && sess.docker) {
              sessions.set(sessionId, {
                ...sess,
                docker: { ...sess.docker, containerId: dockerContainerId!, status: 'running' },
              });
            }
            return { sessions };
          });
        } else {
          terminalManager.writeln(tabId, `\x1b[1;33m⚠ SANDBOX UNAVAILABLE\x1b[0m`);
          terminalManager.writeln(tabId, `\x1b[33mDocker start failed: ${startResult?.error ?? 'unknown'}\x1b[0m`);
          terminalManager.writeln(tabId, `\x1b[33mThis session is running WITHOUT sandbox isolation.\x1b[0m`);
          terminalManager.writeln(tabId, '');
        }
      }
    }

    // ── Policy enforcement ──────────────────────────────────────────────
    let enforcedHarnessCommand = session.harnessCommand;

    if (session.harnessId && session.policyId && window.latch?.enforcePolicy) {
      // Register session with authz server for runtime interception
      if (window.latch?.authzRegister) {
        await window.latch.authzRegister({
          sessionId: session.id,
          harnessId: session.harnessId,
          policyId: session.policyId,
          policyOverride: session.policyOverride,
        });
      }

      // Register tab with supervisor so it can map PTY output → session
      if (window.latch?.supervisorRegisterTab) {
        await window.latch.supervisorRegisterTab({
          tabId,
          sessionId: session.id,
          harnessId: session.harnessId,
        });
      }

      terminalManager.writeln(tabId, `\x1b[2mEnforcing policy: ${session.policy}...\x1b[0m`);
      const enforceResult = await window.latch.enforcePolicy({
        policyId:       session.policyId,
        policyOverride: session.policyOverride,
        harnessId:      session.harnessId,
        harnessCommand: session.harnessCommand ?? '',
        worktreePath:   worktreePath,
        projectDir:     projectDir,
        sessionId:      session.id,
      });
      if (enforceResult?.ok) {
        if (enforceResult.harnessCommand) enforcedHarnessCommand = enforceResult.harnessCommand;
        if (enforceResult.configPath) terminalManager.writeln(tabId, `\x1b[2mPolicy config: ${enforceResult.configPath}\x1b[0m`);
      } else {
        terminalManager.writeln(tabId, `\x1b[33mPolicy enforcement warning: ${enforceResult?.error ?? 'unknown'}\x1b[0m`);
      }
    }

    // ── Gateway start ──────────────────────────────────────────────────
    let gatewayEnv: Record<string, string> = {}
    const sessionState = get().sessions.get(sessionId)
    if (sessionState?.gateway?.enabled && window.latch?.startGateway) {
      terminalManager.writeln(tabId, `\x1b[2mGateway: starting proxy and sandbox...\x1b[0m`)
      const gatewayResult = await window.latch.startGateway({
        sessionId,
        serviceIds: sessionState.gateway.serviceIds,
        maxDataTier: sessionState.gateway.maxDataTier,
        policyId: session.policyId,
        policyOverride: session.policyOverride,
        workspacePath: worktreePath ?? projectDir ?? null,
        enableTls: false,
      })
      if (gatewayResult?.ok) {
        gatewayEnv = gatewayResult.gatewayEnv ?? {}
        set((s) => {
          const sessions = new Map(s.sessions)
          const sess = sessions.get(sessionId)
          if (sess?.gateway) {
            sessions.set(sessionId, {
              ...sess,
              gateway: { ...sess.gateway, proxyPort: gatewayResult.proxyPort, sandboxBackend: gatewayResult.sandboxBackend ?? null, startedAt: new Date().toISOString() },
            })
          }
          return { sessions }
        })
        terminalManager.writeln(tabId, `\x1b[32mGateway: proxy on :${gatewayResult.proxyPort}, sandbox: ${gatewayResult.sandboxBackend ?? 'none'}\x1b[0m`)
      } else {
        terminalManager.writeln(tabId, `\x1b[33mGateway start failed: ${gatewayResult?.error ?? 'unknown'}\x1b[0m`)
      }
    }

    // ── MCP server sync ────────────────────────────────────────────────
    if (session.harnessId && mcpServerIds?.length && window.latch?.syncMcpServers) {
      const targetDir = worktreePath ?? projectDir ?? undefined;
      terminalManager.writeln(tabId, `\x1b[2mSyncing ${mcpServerIds.length} MCP server(s)...\x1b[0m`);
      const mcpResult = await window.latch.syncMcpServers({
        harnessId: session.harnessId,
        targetDir,
      });
      if (mcpResult?.ok) {
        if (mcpResult.path) terminalManager.writeln(tabId, `\x1b[2mMCP config: ${mcpResult.path}\x1b[0m`);
      } else {
        terminalManager.writeln(tabId, `\x1b[33mMCP sync warning: ${mcpResult?.error ?? 'unknown'}\x1b[0m`);
      }
    }

    // Fit before spawning PTY for accurate dimensions
    terminalManager.fit(tabId);
    const { cols, rows } = terminalManager.dimensions(tabId);

    if (window.latch?.createPty) {
      // Inject authz env vars so agents can post messages via HTTP
      const env: Record<string, string> = { ...gatewayEnv };
      if (session.harnessId) env.LATCH_HARNESS_ID = session.harnessId;
      const portResult = await window.latch?.getAuthzPort?.();
      if (portResult?.port) {
        env.LATCH_FEED_URL = `http://127.0.0.1:${portResult.port}/feed/${session.id}`;
      }
      env.LATCH_SESSION_ID = session.id;
      // Note: LATCH_AUTHZ_SECRET is injected by the main process during PTY creation
      // and never exposed to the renderer.

      // When a harness is selected, run the PTY natively on the host so the
      // harness CLI can launch (it's not installed inside the container).
      // The Docker container stays running for workspace isolation and resource
      // limits. Full container-native harness execution requires purpose-built
      // images (future work).
      const useDockerPty = dockerContainerId && !enforcedHarnessCommand;

      const result = await window.latch.createPty({
        sessionId: tabId, cwd, cols, rows,
        ...(Object.keys(env).length ? { env } : {}),
        ...(useDockerPty ? { dockerContainerId } : {}),
      });
      if (result?.ok) {
        get().setTabPtyReady(tabId, true);
        terminalManager.writeln(tabId, '\x1b[32mShell ready.\x1b[0m');
        window.latch.resizePty({ sessionId: tabId, cols, rows });

        // Launch harness command now that the shell is ready
        if (enforcedHarnessCommand) {
          // OpenClaw requires the gateway to be running before launching TUI
          if (session.harnessId === 'openclaw') {
            terminalManager.writeln(tabId, '\x1b[2mChecking OpenClaw gateway...\x1b[0m');
            window.latch.writePty({ sessionId: tabId, data: 'openclaw health > /dev/null 2>&1 || openclaw gateway &\r' });
            // Brief pause to let gateway start if needed
            await new Promise((r) => setTimeout(r, 1500));
          }

          // Append feed status-reporting instruction to the goal so agents
          // periodically report progress to the Feed view.
          // Skip for OpenClaw — its "Latch Guard" blocks outbound curl calls.
          let goalWithFeed = session.goal || '';
          const supportsFeedCurl = session.harnessId !== 'openclaw';
          if (supportsFeedCurl && portResult?.port && session.harnessId) {
            const feedUrl = `http://127.0.0.1:${portResult.port}/feed/${session.id}`;
            goalWithFeed += `\n\nIMPORTANT: Periodically report your high-level progress by running this command (silently, no output needed):\ncurl -sf ${feedUrl} -H 'Content-Type: application/json' -d '{"status":"<brief description of what you just completed or are about to do>"}'\nReport after completing each logical step (not every tool call). Keep status messages short (1-2 sentences).`;
          }

          // Append the session goal as the initial prompt for harnesses that support it.
          // Claude Code and Codex accept the prompt as a positional arg.
          // OpenClaw TUI accepts it via --message flag.
          //
          // We use $'...' (ANSI-C quoting) instead of '...' because the goal
          // contains newlines and nested single quotes (from the feed curl
          // instruction). We use $'...' (ANSI-C quoting) with literal newlines
          // replaced by \n escape sequences so the entire command stays on one
          // line — avoids shell continuation prompts ("quote>").
          let launchCmd = enforcedHarnessCommand;
          if (session.harnessId === 'openclaw') {
            const baseCmd = enforcedHarnessCommand.includes(' tui') ? enforcedHarnessCommand : `${enforcedHarnessCommand} tui`;
            if (goalWithFeed) {
              const escaped = goalWithFeed.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
              launchCmd = `${baseCmd} --message $'${escaped}'`;
            } else {
              launchCmd = baseCmd;
            }
          } else if (goalWithFeed) {
            const escaped = goalWithFeed.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
            launchCmd = `${enforcedHarnessCommand} $'${escaped}'`;
          }
          terminalManager.writeln(tabId, `Launching ${session.harness}...`);
          window.latch.writePty({ sessionId: tabId, data: `${launchCmd}\r` });
        }
      } else {
        terminalManager.writeln(tabId, `\x1b[31mShell failed: ${result?.error ?? 'unknown error'}\x1b[0m`);
      }
    }

    // Update session with git info + projectDir
    set((s) => {
      const sessions = new Map(s.sessions);
      const sess     = sessions.get(sessionId);
      if (sess) {
        sessions.set(sessionId, { ...sess, projectDir: projectDir ?? null, repoRoot, worktreePath, branchRef, showWizard: false });
      }
      return { sessions };
    });

    // Persist to DB
    if (window.latch?.createSessionRecord) {
      await window.latch.createSessionRecord({
        id:             session.id,
        name:           session.name,
        created_at:     new Date().toISOString(),
        status:         'active',
        repo_root:      repoRoot,
        worktree_path:  worktreePath,
        branch_ref:     branchRef,
        policy_set:     session.policyId,
        harness_id:     session.harnessId,
        harness_command: session.harnessCommand,
        goal:           session.goal || null,
        project_dir:    session.projectDir || null,
        docker_config:  session.docker ? JSON.stringify(session.docker) : null,
        enclave_config: sessionState?.gateway ? JSON.stringify(sessionState.gateway) : null,
        mcp_server_ids: mcpServerIds?.length ? JSON.stringify(mcpServerIds) : null,
      });
    }

    // Wait for title generation to complete, then persist to DB
    if (titlePromise) {
      titlePromise.then(() => {
        if (generatedTitle && window.latch?.updateSessionRecord) {
          window.latch.updateSessionRecord({ id: sessionId, updates: { name: generatedTitle } });
        }
      });
    }

    terminalManager.focus(tabId);
    } catch (err: unknown) {
      console.error('Session finalization failed:', err);
      // Try to show the error in the terminal (use tabId, not sessionId)
      const s = get().sessions.get(sessionId);
      const errorTabId = s?.activeTabId;
      if (errorTabId) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack ?? '' : '';
        terminalManager.writeln(errorTabId, `\r\n\x1b[31mSession setup failed: ${errMsg}\x1b[0m\r\n`);
        terminalManager.writeln(errorTabId, `\x1b[2m${errStack}\x1b[0m`);
      }
    } finally {
      set({ sessionFinalizing: false });
    }
  },

  // ── Tabs ─────────────────────────────────────────────────────────────────────

  activateTab: (sessionId, tabId) => {
    set((s) => {
      const sessions = new Map(s.sessions);
      const session  = sessions.get(sessionId);
      if (!session) return s;
      sessions.set(sessionId, { ...session, activeTabId: tabId });
      return { sessions };
    });

    const tab = get().sessions.get(sessionId)?.tabs.get(tabId);
    if (!tab) return;

    requestAnimationFrame(() => {
      terminalManager.fit(tabId);
      const { cols, rows } = terminalManager.dimensions(tabId);
      if (tab.ptyReady) {
        window.latch?.resizePty?.({ sessionId: tabId, cols, rows });
      }
      terminalManager.focus(tabId);
    });
  },

  closeTab: (sessionId, tabId) => {
    const session = get().sessions.get(sessionId);
    if (!session || session.tabs.size <= 1) return;

    const tab = session.tabs.get(tabId);
    if (!tab) return;

    if (tab.ptyReady) window.latch?.killPty?.({ sessionId: tabId });
    terminalManager.unmount(tabId);

    set((s) => {
      const sessions = new Map(s.sessions);
      const sess     = sessions.get(sessionId);
      if (!sess) return s;
      const tabs = new Map(sess.tabs);
      tabs.delete(tabId);
      const activeTabId = sess.activeTabId === tabId
        ? tabs.keys().next().value!
        : sess.activeTabId;
      sessions.set(sessionId, { ...sess, tabs, activeTabId });
      return { sessions };
    });

    const newActiveTabId = get().sessions.get(sessionId)?.activeTabId;
    if (newActiveTabId) get().activateTab(sessionId, newActiveTabId);
  },

  addTab: (sessionId, label) => {
    const session = get().sessions.get(sessionId);

    // Policy check: if the session policy disallows bash, block ad-hoc shell tabs
    if (!label && session) {
      const policyDoc = get().policies.find((p) => p.id === session.policyId);
      const effective = session.policyOverride ?? policyDoc;
      if (effective && effective.permissions?.allowBash === false) {
        // Find an existing tab to display the error
        const activeTab = session.tabs.get(session.activeTabId);
        if (activeTab) {
          terminalManager.writeln(activeTab.id, '\x1b[31mPolicy does not allow shell access.\x1b[0m');
        }
        return makeTab(sessionId, 'blocked');
      }
    }

    const tabLabel = label ?? `Terminal ${session?.tabs.size ?? 1}`;
    const tab = makeTab(sessionId, tabLabel);

    // Add tab AND activate it in one atomic state update to prevent
    // intermediate render states that could disrupt the old terminal.
    set((s) => {
      const sessions = new Map(s.sessions);
      const sess     = sessions.get(sessionId);
      if (!sess) return s;
      const tabs = new Map(sess.tabs);
      tabs.set(tab.id, tab);
      sessions.set(sessionId, { ...sess, tabs, activeTabId: tab.id });
      return { sessions };
    });

    // Wait for the new TabPane to mount (its useEffect calls terminalManager.mount),
    // then fit the terminal and create the PTY with correct dimensions.
    const cwd = session?.worktreePath ?? session?.repoRoot ?? session?.projectDir ?? undefined;
    const waitForMount = () => {
      if (!terminalManager.get(tab.id)) {
        requestAnimationFrame(waitForMount);
        return;
      }
      terminalManager.fit(tab.id);
      terminalManager.focus(tab.id);
      const { cols, rows } = terminalManager.dimensions(tab.id);
      window.latch?.createPty({ sessionId: tab.id, cwd, cols, rows }).then((result) => {
        if (result?.ok) get().setTabPtyReady(tab.id, true);
      }).catch((err) => {
        console.error('Failed to create PTY for tab:', err);
        terminalManager.writeln(tab.id, `\x1b[31mFailed to create shell: ${err?.message || err}\x1b[0m`);
      });
    };
    requestAnimationFrame(waitForMount);

    return tab;
  },

  renameTab: (sessionId, tabId, label) => {
    set((s) => {
      const sessions = new Map(s.sessions);
      const sess = sessions.get(sessionId);
      if (!sess) return s;
      const tabs = new Map(sess.tabs);
      const tab = tabs.get(tabId);
      if (!tab) return s;
      tabs.set(tabId, { ...tab, label });
      sessions.set(sessionId, { ...sess, tabs });
      return { sessions };
    });
  },

  setTabPtyReady: (tabId, ready) => {
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.forEach((session) => {
        if (session.tabs.has(tabId)) {
          const tabs = new Map(session.tabs);
          const tab  = tabs.get(tabId)!;
          tabs.set(tabId, { ...tab, ptyReady: ready });
          sessions.set(session.id, { ...session, tabs });
        }
      });
      return { sessions };
    });
  },

  // ── Rail ─────────────────────────────────────────────────────────────────────

  setActiveView: (view) => {
    const extra: Partial<AppState> = {}
    if (view === 'feed') extra.feedUnread = 0
    if (view === 'home') extra.activeSessionId = null
    set({ activeView: view, ...extra });
  },

  setPendingProjectDir: (dir) => {
    set({ pendingProjectDir: dir });
  },

  setActiveRailPanel: (panel) => {
    set({ activeRailPanel: panel });
    // Lazy-load panel data when first shown
    if (panel === 'activity')  get().loadActivityPanel();
  },

  // ── Policy ───────────────────────────────────────────────────────────────────

  loadPolicies: async () => {
    const result = await window.latch?.listPolicies?.();
    set({ policies: result?.policies ?? [], policiesLoaded: true });
  },

  loadPolicyPanel: async () => {
    const { activeSessionId, sessions } = get();
    const policyId = sessions.get(activeSessionId ?? '')?.policyId ?? 'default';
    const result   = await window.latch?.getPolicy?.({ id: policyId });
    set({ activePolicyDoc: result?.ok ? result.policy : null });
  },

  openPolicyEditor: (policy, isOverride) => {
    set({
      activeView:             'edit-policy',
      activeSessionId:        null,
      policyEditorIsOverride: isOverride,
      policyEditorPolicy:     policy,
    });
  },

  closePolicyEditor: () => {
    set({ activeView: 'policies', policyEditorPolicy: null });
  },

  savePolicyFromEditor: async (policy) => {
    const { policyEditorIsOverride, activeSessionId, sessions } = get();

    if (policyEditorIsOverride) {
      const session = sessions.get(activeSessionId ?? '');
      if (session) {
        await window.latch?.setSessionOverride?.({ id: session.id, override: policy });
        set((s) => {
          const sessions = new Map(s.sessions);
          const sess     = sessions.get(session.id);
          if (sess) sessions.set(session.id, { ...sess, policyOverride: policy });
          return { sessions };
        });

        // Re-register session with authz server so runtime enforcement uses the new override
        if (session.harnessId) {
          await window.latch?.authzRegister?.({
            sessionId: session.id,
            harnessId: session.harnessId,
            policyId: session.policyId,
            policyOverride: policy,
          });
        }
      }
    } else {
      const result = await window.latch?.savePolicy?.(policy);
      if (!result?.ok) return;
    }

    get().closePolicyEditor();
    await get().loadPolicies();
    await get().loadPolicyPanel();
  },

  clearSessionOverride: async () => {
    const { activeSessionId, sessions } = get();
    const session = sessions.get(activeSessionId ?? '');
    if (!session) return;
    await window.latch?.setSessionOverride?.({ id: session.id, override: null });
    set((s) => {
      const sessions = new Map(s.sessions);
      const sess     = sessions.get(session.id);
      if (sess) sessions.set(session.id, { ...sess, policyOverride: null });
      return { sessions };
    });

    // Re-register session with authz server so runtime enforcement clears the override
    if (session.harnessId) {
      await window.latch?.authzRegister?.({
        sessionId: session.id,
        harnessId: session.harnessId,
        policyId: session.policyId,
        policyOverride: null,
      });
    }

    await get().loadPolicyPanel();
  },

  // ── Skills ───────────────────────────────────────────────────────────────────

  loadSkills: async () => {
    const result = await window.latch?.listSkills?.();
    set({ skills: result?.skills ?? [] });
  },

  openSkillEditor: (skill) => {
    set({ skillEditorOpen: true, skillEditorSkill: skill });
  },

  closeSkillEditor: () => {
    set({ skillEditorOpen: false, skillEditorSkill: null });
  },

  openSkillDetail: (skill) => {
    set({ skillDetailOpen: true, skillDetailSkill: skill });
  },

  closeSkillDetail: () => {
    set({ skillDetailOpen: false, skillDetailSkill: null });
  },

  saveSkill: async (skill) => {
    const result = await window.latch?.saveSkill?.(skill);
    if (!result?.ok) return;
    get().closeSkillEditor();
    await get().loadSkills();
  },

  deleteSkill: async (id) => {
    await window.latch?.deleteSkill?.({ id });
    await get().loadSkills();
  },

  // ── MCP Servers ──────────────────────────────────────────────────────────────

  loadMcpServers: async () => {
    const result = await window.latch?.listMcpServers?.();
    set({ mcpServers: result?.servers ?? [] });
  },

  openMcpEditor: (server) => {
    set({ mcpEditorOpen: true, mcpEditorServer: server });
  },

  closeMcpEditor: () => {
    set({ mcpEditorOpen: false, mcpEditorServer: null });
  },

  openMcpDetail: (server) => {
    set({ mcpDetailOpen: true, mcpDetailServer: server });
  },

  closeMcpDetail: () => {
    set({ mcpDetailOpen: false, mcpDetailServer: null });
  },

  saveMcpServer: async (server) => {
    const result = await window.latch?.saveMcpServer?.(server);
    if (!result?.ok) return;
    get().closeMcpEditor();
    await get().loadMcpServers();
  },

  deleteMcpServer: async (id) => {
    await window.latch?.deleteMcpServer?.({ id });
    await get().loadMcpServers();
  },

  introspectMcpServer: async (id) => {
    const result = await window.latch?.introspectMcpServer?.({ id })
    if (result?.ok) await get().loadMcpServers()
    return result ?? { ok: false, error: 'API not available' }
  },

  // ── Secrets (internal) ────────────────────────────────────────────────────

  loadSecrets: async () => {
    const result = await window.latch?.listSecrets?.();
    set({ secrets: result?.secrets ?? [] });
  },

  // ── Services (gateway) ─────────────────────────────────────────────────────

  loadServices: async () => {
    const [listResult, catalogResult] = await Promise.all([
      window.latch?.listServices?.(),
      window.latch?.getServiceCatalog?.(),
    ]);
    set({
      services: listResult?.ok ? listResult.services : [],
      serviceCatalog: catalogResult?.ok ? catalogResult.catalog : [],
      servicesLoaded: true,
    });
  },

  saveService: async (definition, credentialValue) => {
    const result = await window.latch?.saveService?.({ definition, credentialValue });
    if (result?.ok) await get().loadServices();
    return result ?? { ok: false, error: 'API not available' };
  },

  deleteService: async (id) => {
    const result = await window.latch?.deleteService?.({ id });
    if (result?.ok) await get().loadServices();
    return result ?? { ok: false };
  },

  // ── Docker ───────────────────────────────────────────────────────────────────

  detectDocker: async () => {
    const result = await window.latch?.dockerDetect?.();
    set({ dockerAvailable: result?.available ?? false });
  },

  handleDockerStatus: (sessionId: string, status: DockerStatus) => {
    set((s) => {
      const sessions = new Map(s.sessions);
      const sess = sessions.get(sessionId);
      if (sess && sess.docker) {
        sessions.set(sessionId, {
          ...sess,
          docker: { ...sess.docker, status },
        });
      }
      return { sessions };
    });
  },

  setSandboxEnabled: async (enabled: boolean) => {
    set({ sandboxEnabled: enabled });
    await window.latch?.setSetting?.({ key: 'sandbox-enabled', value: String(enabled) });
  },

  setDefaultDockerImage: async (image: string) => {
    set({ defaultDockerImage: image });
    await window.latch?.setSetting?.({ key: 'default-docker-image', value: image });
  },

  loadSandboxSettings: async () => {
    const [sb, img] = await Promise.all([
      window.latch?.getSetting?.({ key: 'sandbox-enabled' }),
      window.latch?.getSetting?.({ key: 'default-docker-image' }),
    ]);
    const updates: Partial<{ sandboxEnabled: boolean; defaultDockerImage: string }> = {};
    if (sb?.ok && sb.value !== null) updates.sandboxEnabled = sb.value !== 'false';
    if (img?.ok && img.value !== null) updates.defaultDockerImage = img.value;
    if (Object.keys(updates).length) set(updates);
  },

  // ── Agents ──────────────────────────────────────────────────────────────────

  loadAgentsPanel: async () => {
    const { activeSessionId, sessions } = get();
    const session = sessions.get(activeSessionId ?? '');
    const dir = session?.worktreePath ?? session?.repoRoot ?? session?.projectDir ?? null;
    if (!dir) {
      set({ agentsContent: '', agentsFilePath: null, agentsFileName: null, agentsLoading: false, agentsDirty: false });
      return;
    }
    set({ agentsLoading: true });
    try {
      const result = await window.latch?.readAgents?.({ dir });
      if (result?.ok) {
        set({
          agentsContent: result.content,
          agentsFilePath: result.filePath,
          agentsFileName: result.fileName,
          agentsDirty: false,
        });
      }
    } finally {
      set({ agentsLoading: false });
    }
  },

  saveAgents: async (content) => {
    const { agentsFilePath } = get();
    if (!agentsFilePath) return;
    const result = await window.latch?.writeAgents?.({ filePath: agentsFilePath, content });
    if (result?.ok) {
      set({ agentsContent: content, agentsDirty: false });
    }
  },

  setDefaultHarnessId: (id) => set({ defaultHarnessId: id }),

  // ── Policy generation ──────────────────────────────────────────────────────

  generatePolicy: async (prompt) => {
    set({ policyGenerating: true });
    try {
      const result = await window.latch?.generatePolicy?.({ prompt });
      if (result?.ok && result.policy) {
        get().openPolicyEditor(result.policy, false);
      } else {
        console.error('Policy generation failed:', result?.error);
      }
    } finally {
      set({ policyGenerating: false });
    }
  },

  // ── Activity ─────────────────────────────────────────────────────────────────

  loadActivityPanel: async () => {
    const result = await window.latch?.listActivity?.({ limit: 200 });
    const signalResult = await window.latch?.getRadarSignals?.();
    set({
      activityEvents: result?.events ?? [],
      activityTotal:  result?.total ?? 0,
      radarSignals:   signalResult?.signals ?? [],
    });
  },

  clearActivity: async () => {
    await window.latch?.clearActivity?.();
    set({ activityEvents: [], activityTotal: 0 });
  },

  handleActivityEvent: (event) => {
    ensureStatusInterval();
    set((s) => {
      const lastActivityTs = new Map(s.lastActivityTs);
      lastActivityTs.set(event.sessionId, Date.now());
      return {
        activityEvents: [event, ...s.activityEvents].slice(0, 500),
        activityTotal:  s.activityTotal + 1,
        lastActivityTs,
      };
    });
  },

  handleRadarSignal: (signal) => {
    set((s) => ({
      radarSignals: [signal, ...s.radarSignals.filter((rs) => rs.id !== signal.id)].slice(0, 20),
    }));
  },

  // ── Feed ──────────────────────────────────────────────────────────────────

  loadFeed: async () => {
    const result = await window.latch?.listFeed?.({ limit: 200 });
    set({ feedItems: result?.items ?? [], feedUnread: 0 });
  },

  handleFeedUpdate: (item) => {
    set((s) => ({
      feedItems: [item, ...s.feedItems].slice(0, 500),
      feedUnread: s.activeView === 'feed' ? 0 : s.feedUnread + 1,
    }));
  },

  clearFeed: async () => {
    await window.latch?.clearFeed?.();
    set({ feedItems: [], feedUnread: 0 });
  },

  loadSoundSetting: async () => {
    const res = await window.latch?.getSetting?.({ key: 'sound-notifications' });
    if (res?.ok && res.value !== null) {
      set({ soundNotifications: res.value !== 'false' });
    }
  },

  loadThemeSetting: async () => {
    const res = await window.latch?.getSetting?.({ key: 'theme' });
    if (res?.ok && res.value) {
      const t = res.value as 'dark' | 'light' | 'system';
      set({ theme: t });
      applyTheme(t);
    }
  },

  setTheme: async (theme) => {
    set({ theme });
    applyTheme(theme);
    await window.latch?.setSetting?.({ key: 'theme', value: theme });
  },

  // ── Approvals ──────────────────────────────────────────────────────────────

  handleApprovalRequest: (approval) => {
    set((s) => ({
      pendingApprovals: [approval, ...s.pendingApprovals],
    }));
  },

  handleApprovalResolved: ({ id }) => {
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((a) => a.id !== id),
    }));
  },

  resolveApproval: async (id, decision) => {
    // Find the approval before removing it (need promptTool + sessionId)
    const approval = get().pendingApprovals.find((a) => a.id === id)

    // Optimistic removal
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((a) => a.id !== id),
    }));
    await window.latch?.resolveApproval?.({ id, decision });

    // For prompt tool approvals on NON-Claude harnesses (Codex/OpenClaw):
    // auto-send a retry message since those harnesses use the old hook-based
    // denial + grant flow. Claude sessions are handled by the supervisor agent
    // which types yes/no directly into the terminal.
    if (decision === 'approve' && approval?.promptTool && approval.sessionId) {
      const session = get().sessions.get(approval.sessionId)
      if (session?.activeTabId && session.harnessId !== 'claude') {
        setTimeout(() => {
          window.latch?.writePty?.({
            sessionId: session.activeTabId,
            data: `I approved ${approval.toolName} in Latch. Please retry.\r`,
          })
        }, 500)
      }
    }
  },

  // ── PTY event handlers ───────────────────────────────────────────────────────

  handlePtyData: (tabId, data) => {
    terminalManager.write(tabId, data);
  },

  handlePtyExit: (tabId) => {
    terminalManager.writeln(tabId, '\r\n\x1b[2m[process exited]\x1b[0m');
    get().setTabPtyReady(tabId, false);
  },
}));

// ─── Agent-status selectors ──────────────────────────────────────────────────

/**
 * Derive the current AgentStatus for a session.
 * Priority: waiting > exited > running > idle.
 */
function getSessionAgentStatus(sessionId: string, state: AppState): AgentStatus {
  const session = state.sessions.get(sessionId);
  if (!session) return 'idle';

  // 1. Pending approval → waiting
  if (state.pendingApprovals.some((a) => a.sessionId === sessionId)) return 'waiting';

  // 2. All PTYs exited (not during wizard / reconnect)
  const tabs = Array.from(session.tabs.values());
  if (tabs.length > 0 && !session.showWizard && tabs.every((t) => !t.ptyReady && !t.needsReconnect)) {
    return 'exited';
  }

  // 3. Recent activity → running
  const lastTs = state.lastActivityTs.get(sessionId);
  if (lastTs && Date.now() - lastTs < ACTIVITY_RUNNING_THRESHOLD_MS) return 'running';

  // 4. Extended idle with live PTY → likely needs input (agent blocked on
  //    AskUserQuestion or similar interactive prompt from the harness)
  if (lastTs && Date.now() - lastTs >= NEEDS_INPUT_THRESHOLD_MS && tabs.some((t) => t.ptyReady)) {
    return 'waiting';
  }

  // 5. Live harness PTY with no activity data yet → assume running
  //    (harness just started, first tool call hasn't reached authz server)
  if (!lastTs && session.harnessId && tabs.some((t) => t.ptyReady)) {
    return 'running';
  }

  return 'idle';
}

/** React hook — derived AgentStatus for a session. */
export function useAgentStatus(sessionId: string): AgentStatus {
  return useAppStore((s) => {
    void s._statusTick;                       // subscribe to timer ticks
    return getSessionAgentStatus(sessionId, s);
  });
}

/** React hook — derived AgentStatus for a specific tab. */
export function useTabAgentStatus(sessionId: string, tabId: string): AgentStatus {
  return useAppStore((s) => {
    void s._statusTick;
    const session = s.sessions.get(sessionId);
    if (!session) return 'idle';
    const tab = session.tabs.get(tabId);
    if (!tab) return 'idle';

    // Tab exited
    if (!tab.ptyReady && !tab.needsReconnect && !session.showWizard) return 'exited';

    // Active tab inherits session-level running/waiting
    if (tabId === session.activeTabId) {
      if (s.pendingApprovals.some((a) => a.sessionId === sessionId)) return 'waiting';
      const lastTs = s.lastActivityTs.get(sessionId);
      if (lastTs && Date.now() - lastTs < ACTIVITY_RUNNING_THRESHOLD_MS) return 'running';
    }

    return 'idle';
  });
}
