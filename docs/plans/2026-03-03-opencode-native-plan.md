# OpenCode-Native Harness Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make OpenCode the default harness in Latch Desktop with full policy enforcement via plugin injection, skills sync, MCP sync, one-click install, and a universal model picker.

**Architecture:** Plugin-first integration using OpenCode's `tool.execute.before/after` hooks for runtime authz + feed, `opencode.json` permission config for baseline enforcement, and `.opencode/agents/` for skills injection. OpenCode is always pre-selected as the default harness; users can install it with one click if missing.

**Tech Stack:** TypeScript (Electron main + renderer), Zustand, node-pty, JSONC config files

---

## Phase 1: Core OpenCode Integration

### Task 1: Add `OpenCodePolicyConfig` type and update `HarnessesConfig`

**Files:**
- Modify: `src/types/index.ts:69-80`

**Step 1: Add `OpenCodePolicyConfig` interface after `OpenClawPolicyConfig`**

Add the following interface after line 74 (`}`):

```typescript
export interface OpenCodePolicyConfig {
  /** Tool-level permission rules (opencode permission keys: bash, edit, read, etc.). */
  toolRules?: ToolRule[];
  mcpServerRules?: McpServerRule[];
}
```

**Step 2: Add `opencode` to `HarnessesConfig`**

Update the `HarnessesConfig` interface to include the new type:

```typescript
export interface HarnessesConfig {
  claude?: ClaudePolicyConfig;
  codex?: CodexPolicyConfig;
  openclaw?: OpenClawPolicyConfig;
  opencode?: OpenCodePolicyConfig;
}
```

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add OpenCodePolicyConfig and wire into HarnessesConfig"
```

---

### Task 2: Update harness detection — OpenCode first, XDG-aware

**Files:**
- Modify: `src/main/lib/harnesses.ts:9-15`

**Step 1: Move `opencode` to the top of `HARNESS_DEFINITIONS`**

Reorder the array so opencode appears first (it will be detected first and appear first in the UI):

```typescript
const HARNESS_DEFINITIONS = [
  { id: 'opencode', label: 'OpenCode',    dotDir: '.opencode', commands: ['opencode'],              url: 'https://opencode.ai' },
  { id: 'claude',   label: 'Claude Code', dotDir: '.claude',   commands: ['claude', 'claude-code'], url: 'https://claude.ai/code' },
  { id: 'codex',    label: 'Codex',       dotDir: '.codex',    commands: ['codex'],                 url: 'https://openai.com/codex' },
  { id: 'openclaw', label: 'OpenClaw',    dotDir: '.openclaw', commands: ['openclaw'],              url: '' },
  { id: 'droid',    label: 'Droid',       dotDir: '.factory',  commands: ['droid'],                 url: 'https://droid.dev' },
]
```

**Step 2: Enhance detection to also check XDG config path**

OpenCode stores its global config at `~/.config/opencode/opencode.json`, not in a `~/.opencode` dotdir. Update the `detectHarness` function to also check the XDG path for opencode:

```typescript
async function detectHarness(definition: typeof HARNESS_DEFINITIONS[number], homeDir: string) {
  const dotDirPath = path.join(homeDir, definition.dotDir)
  const hasDotDir = await pathExists(dotDirPath)

  // OpenCode also uses XDG config path
  let hasXdgConfig = false
  if (definition.id === 'opencode') {
    const xdgConfigPath = path.join(homeDir, '.config', 'opencode', 'opencode.json')
    hasXdgConfig = await pathExists(xdgConfigPath)
  }

  const commandChecks = await Promise.all(
    definition.commands.map(async (command) => {
      const resolved = await which(command)
      return resolved ? { command, path: resolved } : null
    })
  )
  const availableCommands = commandChecks.filter(Boolean) as { command: string; path: string }[]
  const installed = availableCommands.length > 0 || hasDotDir || hasXdgConfig

  let recommendedCommand = availableCommands[0]?.command ?? ((hasDotDir || hasXdgConfig) ? definition.commands[0] : null)
  if (definition.id === 'openclaw' && recommendedCommand) {
    recommendedCommand = `${recommendedCommand} tui`
  }

  return {
    id: definition.id,
    label: definition.label,
    dotDir: definition.dotDir,
    dotDirPath,
    hasDotDir,
    availableCommands,
    recommendedCommand,
    installed,
    url: definition.url
  }
}
```

**Step 3: Commit**

```bash
git add src/main/lib/harnesses.ts
git commit -m "feat(harness): make opencode first in detection order, add XDG config check"
```

---

### Task 3: Implement `enforceForOpenCode()` in policy-enforcer

**Files:**
- Modify: `src/main/services/policy-enforcer.ts`

This is the largest task. It adds the `enforceForOpenCode()` function with three enforcement layers:
1. `opencode.json` permission config generation
2. `.opencode/plugins/latch-policy.ts` plugin injection
3. CLI flag modification

**Step 1: Add the `enforceForOpenCode()` function**

Add this function after `enforceForOpenClaw()` (after line 831), before the `enforcePolicy()` entry point:

```typescript
// ─── OpenCode enforcement ────────────────────────────────────────────────────

/** Map Latch PolicyPermissions → OpenCode permission config object.
 *
 *  OpenCode permissions use allow/ask/deny per-tool with optional glob patterns:
 *    { "bash": { "*": "ask", "rm *": "deny" }, "edit": "allow", ... }
 */
function buildOpenCodePermissions(p: PolicyPermissions): Record<string, unknown> {
  const perms: Record<string, unknown> = {}

  // Bash / shell
  if (!p.allowBash) {
    perms.bash = { '*': 'deny' }
  } else if (p.confirmDestructive) {
    const bashRules: Record<string, string> = { '*': 'ask' }
    bashRules['rm *'] = 'deny'
    bashRules['git push --force*'] = 'deny'
    bashRules['git reset --hard*'] = 'deny'
    bashRules['git clean -f*'] = 'deny'
    perms.bash = bashRules
  } else {
    perms.bash = 'allow'
  }

  // File editing
  if (!p.allowFileWrite) {
    perms.edit = 'deny'
  } else {
    perms.edit = 'allow'
  }

  // Reading — apply blockedGlobs
  if (p.blockedGlobs?.length) {
    const readRules: Record<string, string> = { '*': 'allow' }
    for (const glob of p.blockedGlobs) {
      readRules[glob] = 'deny'
    }
    perms.read = readRules

    // Also block writing to blocked globs
    if (p.allowFileWrite) {
      const editRules: Record<string, string> = { '*': 'allow' }
      for (const glob of p.blockedGlobs) {
        editRules[glob] = 'deny'
      }
      perms.edit = editRules
    }
  } else {
    perms.read = 'allow'
  }

  // Network
  if (!p.allowNetwork) {
    perms.webfetch = 'deny'
    perms.websearch = 'deny'
  }

  return perms
}

/** Generate `opencode.json` with Latch permission config, preserving existing user settings.
 *  Writes to the project root (worktree or projectDir).
 */
function generateOpenCodeConfig(
  policy: PolicyDocument,
  targetDir: string,
): string {
  const configPath = path.join(targetDir, 'opencode.json')
  let existing: Record<string, unknown> = {}

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    // Strip JSONC comments before parsing
    const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    existing = JSON.parse(stripped)
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  existing.permission = buildOpenCodePermissions(policy.permissions)

  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return configPath
}

/** Write `.opencode/plugins/latch-policy.ts` plugin for runtime authz interception
 *  and feed reporting via Latch's authz server.
 */
function generateOpenCodePlugin(
  targetDir: string,
  authzOptions: { port: number; sessionId: string; secret: string },
): void {
  const pluginDir = path.join(targetDir, '.opencode', 'plugins')
  fs.mkdirSync(pluginDir, { recursive: true })

  const pluginSrc = `// Generated by Latch Desktop — do not edit manually.
// Runtime policy enforcement plugin for OpenCode.
// Hooks: tool.execute.before (authz gate), tool.execute.after (feed), shell.env (env injection).

const AUTHZ_PORT = ${authzOptions.port};
const AUTHZ_SECRET = '${authzOptions.secret}';
const SESSION_ID = '${authzOptions.sessionId}';
const SUPERVISE_URL = \`http://127.0.0.1:\${AUTHZ_PORT}/supervise/\${SESSION_ID}\`;

export default {
  name: 'latch-policy',

  hooks: {
    'tool.execute.before': async (_ctx, { tool, input }) => {
      try {
        const res = await fetch(SUPERVISE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': \`Bearer \${AUTHZ_SECRET}\`,
          },
          body: JSON.stringify({ tool: tool?.name ?? 'unknown', input }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 403) {
          let reason = 'Blocked by Latch policy';
          try {
            const body = await res.json();
            if (body?.reason) reason = body.reason;
          } catch { /* non-JSON response */ }
          return { abort: true, reason };
        }
      } catch {
        // Fail open — don't block the agent if authz server is unreachable
      }
    },

    'tool.execute.after': async (_ctx, { tool, input, output }) => {
      const feedUrl = process.env.LATCH_FEED_URL;
      if (!feedUrl) return;
      try {
        await fetch(feedUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: \`\${tool?.name ?? 'unknown'}\${typeof input === 'object' && input !== null ? ': ' + (input.file_path || input.command || '').toString().slice(0, 60) : ''}\`,
          }),
          signal: AbortSignal.timeout(3000),
        });
      } catch { /* fire-and-forget */ }
    },

    'shell.env': () => ({
      LATCH_SESSION_ID: SESSION_ID,
      LATCH_HARNESS_ID: 'opencode',
    }),
  },
};
`

  fs.writeFileSync(path.join(pluginDir, 'latch-policy.ts'), pluginSrc, 'utf-8')
}

/** Write `opencode.json` permission config, inject the latch-policy plugin,
 *  and return the modified harness command with any CLI flags.
 */
export function enforceForOpenCode(
  policy: PolicyDocument,
  baseCommand: string,
  targetDir: string,
  authzOptions?: { port: number; sessionId: string; secret: string },
): { harnessCommand: string; configPath: string } {
  // Layer 1: Generate opencode.json with permission config
  const configPath = generateOpenCodeConfig(policy, targetDir)

  // Layer 2: Inject plugin for runtime authz + feed (requires authz server)
  if (authzOptions) {
    validateSessionId(authzOptions.sessionId)
    generateOpenCodePlugin(targetDir, authzOptions)
  }

  // Layer 3: No extra CLI flags needed for opencode by default
  // (model flag is handled by the session wizard, not policy enforcement)
  return { harnessCommand: baseCommand, configPath }
}
```

**Step 2: Add the `opencode` case to the `enforcePolicy()` switch statement**

Find the `switch (harnessId)` block (around line 895). Add a case for `'opencode'` before the `default` case:

```typescript
      case 'opencode': {
        if (!targetDir) return { ok: false, error: 'No project directory or worktree available for policy enforcement.' }
        const authzOpts = (authzPort && sessionId && authzSecret) ? { port: authzPort, sessionId, secret: authzSecret } : undefined
        const { harnessCommand: enforced, configPath } = enforceForOpenCode(effective, harnessCommand, targetDir, authzOpts)
        return { ok: true, harnessCommand: enforced, configPath }
      }
```

**Step 3: Update `resolvePolicy()` to merge opencode harness config**

In `resolvePolicy()` (around line 172-177), add opencode to the harnesses merge:

```typescript
  const harnesses: HarnessesConfig = {
    claude:   mergeHarnessConfig(base.harnesses?.claude,   override.harnesses?.claude),
    codex:    mergeHarnessConfig(base.harnesses?.codex,    override.harnesses?.codex),
    openclaw: mergeHarnessConfig(base.harnesses?.openclaw, override.harnesses?.openclaw),
    opencode: mergeHarnessConfig(base.harnesses?.opencode, override.harnesses?.opencode),
  }
```

**Step 4: Update `computeStrictestBaseline()` to include opencode in harness keys**

In `computeStrictestBaseline()` (around line 60), update the harness keys array to include `'opencode'`:

```typescript
    const harnessKeys = harnessId ? [harnessId] : ['claude', 'codex', 'openclaw', 'opencode']
```

**Step 5: Commit**

```bash
git add src/main/services/policy-enforcer.ts
git commit -m "feat(policy): add enforceForOpenCode with config generation and plugin injection"
```

---

### Task 4: Add OpenCode to skills injection

**Files:**
- Modify: `src/main/stores/skills-store.ts:6-16`

OpenCode uses `.opencode/agents/latch-{id}.md` files instead of the `~/.X/skills/{id}/SKILL.md` pattern. This requires a new sync method.

**Step 1: Add the `syncToAgentsDir` method for opencode agent files**

Add a method after `_syncToSkillsDir()` in the `SkillsStore` class:

```typescript
  /** Write each skill as <agentsDir>/latch-<skill-id>.md with YAML frontmatter.
   *  Used by OpenCode which uses .opencode/agents/*.md files.
   */
  async _syncToAgentsDir(agentsDir: string, skills: any[]) {
    await fs.mkdir(agentsDir, { recursive: true })

    let existingFiles: string[] = []
    try { existingFiles = await fs.readdir(agentsDir) } catch { /* directory doesn't exist yet */ }

    const latchFileNames = new Set(skills.map((s: any) => `latch-${s.id}.md`))

    for (const skill of skills) {
      const frontmatter = [
        '---',
        `name: latch-${skill.id}`,
        skill.description ? `description: ${skill.description}` : null,
        'managed-by: latch',
        '---',
      ].filter(Boolean).join('\n')

      const content = `${frontmatter}\n\n${skill.body}\n`
      await fs.writeFile(path.join(agentsDir, `latch-${skill.id}.md`), content, 'utf8')
    }

    // Clean up stale latch-managed agent files
    for (const file of existingFiles) {
      if (!file.startsWith('latch-') || !file.endsWith('.md')) continue
      if (latchFileNames.has(file)) continue
      const filePath = path.join(agentsDir, file)
      try {
        const content = await fs.readFile(filePath, 'utf8')
        if (!content.includes('managed-by: latch')) continue  // Not ours
        await fs.unlink(filePath)
      } catch { /* can't read — skip */ }
    }

    return { ok: true, path: agentsDir }
  }
```

**Step 2: Update `syncToHarness()` to handle `opencode`**

In the `syncToHarness()` method, add a case for opencode before the existing Codex agent file fallback:

```typescript
  async syncToHarness(harnessId: string) {
    const { skills } = this.listSkills()
    const applicable = skills.filter((s: any) => {
      if (!s.harnesses || s.harnesses.length === 0) return true
      return s.harnesses.includes(harnessId)
    })

    // OpenCode uses .opencode/agents/latch-*.md files (project-level)
    if (harnessId === 'opencode') {
      const agentsDir = path.join(process.cwd(), '.opencode', 'agents')
      return this._syncToAgentsDir(agentsDir, applicable)
    }

    // Harnesses with a skills/ directory (Claude Code, OpenClaw)
    const skillsDir = HARNESS_SKILLS_DIRS[harnessId]
    if (skillsDir) {
      return this._syncToSkillsDir(skillsDir, applicable)
    }

    // Harnesses using markdown injection into a single agent file (Codex)
    const targetPath = HARNESS_AGENT_FILES[harnessId]
    if (!targetPath) return { ok: false, error: `Unknown harness '${harnessId}'.` }

    const skillBlock = this._renderSkillBlock(applicable)

    let existing = ''
    try { existing = await fs.readFile(targetPath, 'utf8') } catch { /* doesn't exist yet */ }

    const updated = this._spliceBlock(existing, skillBlock)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, updated, 'utf8')

    return { ok: true, path: targetPath }
  }
```

**Step 3: Commit**

```bash
git add src/main/stores/skills-store.ts
git commit -m "feat(skills): add opencode agents sync via .opencode/agents/latch-*.md"
```

---

### Task 5: Add OpenCode to MCP config sync

**Files:**
- Modify: `src/main/services/mcp-sync.ts`

OpenCode uses `opencode.json` with a `mcp` key, where each server has `type: "local"`, `command: [...]`, `environment: {...}`.

**Step 1: Add `syncOpenCode()` function**

Add this function after the `syncWindsurf()` function:

```typescript
async function syncOpenCode(
  servers: McpServerForSync[],
  targetDir?: string | null,
  secretContext?: SecretContext | null
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const dir = targetDir || process.cwd()
  const filePath = path.join(dir, 'opencode.json')

  // Read existing config to preserve non-MCP keys
  let existing: Record<string, any> = {}
  try {
    const content = await fs.readFile(filePath, 'utf8')
    // Strip JSONC comments before parsing
    const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    existing = JSON.parse(stripped)
  } catch { /* file doesn't exist or invalid — start fresh */ }

  // Build MCP config in OpenCode's format
  const mcp: Record<string, any> = {}

  const wrapPath = secretContext ? getLatchMcpWrapPath() : null

  for (const s of servers) {
    if (s.transport === 'stdio') {
      if (secretContext && wrapPath && hasSecretRefs(s.env)) {
        // Wrapped entry for secret resolution
        const wrapped = buildWrappedEntry(s, wrapPath, secretContext)
        mcp[s.name] = {
          type: 'local',
          command: [wrapped.command, ...(wrapped.args ?? [])],
          environment: wrapped.env ?? {},
          enabled: true,
        }
      } else {
        const cmd = [s.command ?? '', ...(s.args ?? [])]
        mcp[s.name] = {
          type: 'local',
          command: cmd,
          ...(s.env && Object.keys(s.env).length
            ? { environment: stripSecretRefs(s.env) }
            : {}),
          enabled: true,
        }
      }
    } else if (s.transport === 'http') {
      mcp[s.name] = {
        type: 'remote',
        url: s.url ?? '',
        ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}),
        enabled: true,
      }
    }
  }

  existing.mcp = { ...(existing.mcp ?? {}), ...mcp }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
  return { ok: true, path: filePath }
}
```

**Step 2: Add `'opencode'` case to the `syncMcpToHarness()` switch**

In the `switch (harnessId)` block, add before the `'openclaw'` case:

```typescript
    case 'opencode':
      return syncOpenCode(applicable, targetDir, secretContext)
```

**Step 3: Commit**

```bash
git add src/main/services/mcp-sync.ts
git commit -m "feat(mcp): add opencode MCP sync writing to opencode.json mcp section"
```

---

### Task 6: Add one-click install IPC handler

**Files:**
- Modify: `src/main/index.ts` (add IPC handler)
- Modify: `src/preload/index.ts` (expose to renderer)
- Modify: `src/types/index.ts` (add to LatchAPI)

**Step 1: Add `installHarness` to `LatchAPI` interface**

In `src/types/index.ts`, add to the `LatchAPI` interface (after `detectHarnesses`):

```typescript
  installHarness(payload: { harnessId: string }): Promise<{ ok: boolean; error?: string }>;
```

**Step 2: Add IPC handler in `src/main/index.ts`**

Find where `latch:harness-detect` is handled (around line 563). Add after it:

```typescript
  ipcMain.handle('latch:harness-install', async (_event, payload: { harnessId: string }) => {
    const { harnessId } = payload
    if (harnessId !== 'opencode') {
      return { ok: false, error: `Auto-install not supported for harness '${harnessId}'.` }
    }

    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)

    // Try npm first, then brew on macOS
    try {
      await exec('npm', ['install', '-g', 'opencode-ai'], { timeout: 120000 })
      return { ok: true }
    } catch {
      // npm failed — try brew on macOS
      if (process.platform === 'darwin') {
        try {
          await exec('brew', ['install', 'opencode'], { timeout: 120000 })
          return { ok: true }
        } catch { /* brew also failed */ }
      }
      return { ok: false, error: 'Installation failed. Try running: npm i -g opencode-ai' }
    }
  })
```

**Step 3: Expose in preload**

In `src/preload/index.ts`, add to the `contextBridge.exposeInMainWorld('latch', {...})` object:

```typescript
  installHarness: (payload: { harnessId: string }) => ipcRenderer.invoke('latch:harness-install', payload),
```

**Step 4: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/types/index.ts
git commit -m "feat(harness): add one-click install IPC for opencode (npm/brew)"
```

---

### Task 7: Update session wizard — OpenCode default + install prompt

**Files:**
- Modify: `src/renderer/terminal/TerminalWizard.ts:547-669`
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Reorder wizard harness options so opencode is always first**

In `buildWizardSteps()`, change the harness options building to ensure opencode is first and pre-selected:

```typescript
  // Sort harnesses: opencode first, then the rest
  const sortedHarnesses = [...harnesses].sort((a, b) => {
    if (a.id === 'opencode') return -1
    if (b.id === 'opencode') return 1
    return 0
  })

  const harnessOptions: WizardOption[] = sortedHarnesses.map(h => ({
    label: `${h.label}${h.installed ? '' : ` ${DIM}(not detected)${RESET}`}`,
    value: h.id,
    disabled: !h.installed,
  }))

  // Default to opencode if installed, otherwise first installed harness
  const defaultHarness = sortedHarnesses.find(h => h.id === 'opencode' && h.installed)?.id
    ?? sortedHarnesses.find(h => h.installed)?.id
```

**Step 2: Add install action to store**

In `src/renderer/store/useAppStore.ts`, add an `installHarness` action:

```typescript
  installHarness: async (harnessId: string) => {
    if (!window.latch?.installHarness) return { ok: false, error: 'Not available' }
    const result = await window.latch.installHarness({ harnessId })
    if (result?.ok) {
      // Re-detect harnesses after successful install
      await get().loadHarnesses()
    }
    return result
  },
```

**Step 3: Commit**

```bash
git add src/renderer/terminal/TerminalWizard.ts src/renderer/store/useAppStore.ts
git commit -m "feat(wizard): opencode always first and pre-selected, add install action"
```

---

### Task 8: Add `harness-opencode` CSS styling

**Files:**
- Modify: `src/renderer/styles.css`

**Step 1: Add CSS class for opencode harness badge**

Find existing harness badge styles (search for `harness-claude`) and add:

```css
.harness-opencode {
  color: #00dc82;
}
```

**Step 2: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat(ui): add harness-opencode CSS styling"
```

---

## Phase 2: Universal Model Picker

### Task 9: Add model list IPC handler

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Add types**

In `src/types/index.ts`, add after the `HarnessRecord` interface:

```typescript
export interface ModelRecord {
  id: string           // e.g. "anthropic/claude-sonnet-4-20250514"
  name: string         // e.g. "Claude Sonnet 4"
  provider: string     // e.g. "Anthropic"
  recommended?: boolean
}
```

And add to `LatchAPI`:

```typescript
  listModels(payload: { harnessId: string }): Promise<{ ok: boolean; models: ModelRecord[]; error?: string }>;
```

**Step 2: Add IPC handler**

In `src/main/index.ts`, add a handler that shells out to `opencode models` for opencode, and returns hardcoded lists for other harnesses:

```typescript
  ipcMain.handle('latch:model-list', async (_event, payload: { harnessId: string }) => {
    const { harnessId } = payload

    if (harnessId === 'opencode') {
      // Run `opencode models --format json` to get available models
      try {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const exec = promisify(execFile)
        const { stdout } = await exec('opencode', ['models'], { timeout: 10000 })

        // Parse the output — opencode models outputs a table, parse lines
        const models: Array<{ id: string; name: string; provider: string; recommended?: boolean }> = []
        const lines = stdout.split('\n').filter(Boolean)

        for (const line of lines) {
          // Try to parse provider/model format
          const match = line.match(/^\s*(\S+\/\S+)/)
          if (match) {
            const id = match[1]
            const [provider, ...rest] = id.split('/')
            models.push({
              id,
              name: rest.join('/'),
              provider: provider.charAt(0).toUpperCase() + provider.slice(1),
            })
          }
        }

        if (models.length) return { ok: true, models }
      } catch {
        // Fall through to hardcoded list
      }

      // Fallback: curated model list for opencode
      return {
        ok: true,
        models: [
          { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'Anthropic', recommended: true },
          { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'Anthropic' },
          { id: 'anthropic/claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', provider: 'Anthropic' },
          { id: 'openai/gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI' },
          { id: 'openai/o3', name: 'o3', provider: 'OpenAI' },
          { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google' },
          { id: 'openrouter/auto', name: 'Auto (OpenRouter)', provider: 'OpenRouter' },
        ],
      }
    }

    if (harnessId === 'claude') {
      return {
        ok: true,
        models: [
          { id: 'sonnet', name: 'Claude Sonnet 4', provider: 'Anthropic', recommended: true },
          { id: 'opus', name: 'Claude Opus 4', provider: 'Anthropic' },
          { id: 'haiku', name: 'Claude Haiku 3.5', provider: 'Anthropic' },
        ],
      }
    }

    if (harnessId === 'codex') {
      return {
        ok: true,
        models: [
          { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI', recommended: true },
          { id: 'o3', name: 'o3', provider: 'OpenAI' },
          { id: 'o4-mini', name: 'o4-mini', provider: 'OpenAI' },
        ],
      }
    }

    // Unknown harness — no model list
    return { ok: true, models: [] }
  })
```

**Step 3: Expose in preload**

```typescript
  listModels: (payload: { harnessId: string }) => ipcRenderer.invoke('latch:model-list', payload),
```

**Step 4: Commit**

```bash
git add src/types/index.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(models): add model list IPC with opencode models discovery"
```

---

### Task 10: Add model step to session wizard

**Files:**
- Modify: `src/renderer/terminal/TerminalWizard.ts`
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Add `model` step to `buildWizardSteps()`**

In `buildWizardSteps()`, add a new step after the `harness` step:

```typescript
    {
      id: 'model',
      prompt: 'Model',
      type: 'select',
      options: [],  // Populated dynamically after harness selection
      hint: 'Select an LLM model (or leave blank for default)',
      skip: true,   // Unskipped dynamically after harness step
    },
```

**Step 2: Populate model options dynamically in the wizard's `advance()` method**

When the harness step completes, fetch models and populate the model step's options. Find the section in the wizard's `advance()` method where harness-specific logic runs, and add:

```typescript
    // After harness selection, populate model step options
    if (currentStep.id === 'harness' && answer) {
      const modelStep = this.steps.find(s => s.id === 'model')
      if (modelStep && window.latch?.listModels) {
        const result = await window.latch.listModels({ harnessId: answer })
        if (result?.ok && result.models?.length) {
          modelStep.options = result.models.map(m => ({
            label: `${m.name}${m.recommended ? ' ★' : ''} ${DIM}(${m.provider})${RESET}`,
            value: m.id,
          }))
          // Add "Default" option at the top
          modelStep.options.unshift({ label: 'Default', value: '' })
          modelStep.skip = false
        }
      }
    }
```

**Step 3: Pass model to session creation**

In `useAppStore.ts`, when building the harness command for PTY spawn, check if a model was selected and append `--model`:

```typescript
    // Append model flag if selected
    if (session.model && enforcedHarnessCommand) {
      if (session.harnessId === 'opencode') {
        enforcedHarnessCommand = `${enforcedHarnessCommand} --model ${session.model}`
      } else if (session.harnessId === 'claude') {
        enforcedHarnessCommand = `${enforcedHarnessCommand} --model ${session.model}`
      } else if (session.harnessId === 'codex') {
        enforcedHarnessCommand = `${enforcedHarnessCommand} --model ${session.model}`
      }
    }
```

**Step 4: Add model to SessionRecord and SessionCreateInput types**

In `src/types/index.ts`:

```typescript
// In SessionCreateInput, add:
  model?: string | null

// In SessionRecord, add:
  model: string | null
```

**Step 5: Commit**

```bash
git add src/renderer/terminal/TerminalWizard.ts src/renderer/store/useAppStore.ts src/types/index.ts
git commit -m "feat(wizard): add universal model picker step with per-harness model discovery"
```

---

### Task 11: Persist last-used model per harness

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Save model choice to settings after session creation**

When a session is created with a model selection, persist it:

```typescript
    // After session creation, persist model choice
    if (selectedModel && session.harnessId) {
      window.latch?.setSetting({
        key: `last-model-${session.harnessId}`,
        value: selectedModel,
      })
    }
```

**Step 2: Load last-used model as wizard default**

When building wizard steps, read the persisted model for the selected harness:

```typescript
    const lastModel = await window.latch?.getSetting({
      key: `last-model-${selectedHarnessId}`,
    })
    if (lastModel?.ok && lastModel.value) {
      modelStep.default = lastModel.value
    }
```

**Step 3: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat(models): persist last-used model per harness in settings"
```

---

### Task 12: Type-check and verify

**Step 1: Run the TypeScript compiler**

```bash
cd /Users/cbryant/code/latch-core && npx tsc --noEmit
```

Expected: No type errors related to the new code.

**Step 2: Fix any type errors**

Address any issues found by the compiler.

**Step 3: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve type errors from opencode integration"
```

---

## File Reference

| File | Tasks | Change |
|------|-------|--------|
| `src/types/index.ts` | 1, 6, 9, 10 | `OpenCodePolicyConfig`, `HarnessesConfig`, `ModelRecord`, `LatchAPI`, `SessionCreateInput` |
| `src/main/lib/harnesses.ts` | 2 | Reorder + XDG detection |
| `src/main/services/policy-enforcer.ts` | 3 | `enforceForOpenCode()` + switch case + merge updates |
| `src/main/stores/skills-store.ts` | 4 | `_syncToAgentsDir()` + opencode routing |
| `src/main/services/mcp-sync.ts` | 5 | `syncOpenCode()` + switch case |
| `src/main/index.ts` | 6, 9 | IPC handlers: `latch:harness-install`, `latch:model-list` |
| `src/preload/index.ts` | 6, 9 | `installHarness`, `listModels` |
| `src/renderer/terminal/TerminalWizard.ts` | 7, 10 | Default ordering, model step |
| `src/renderer/store/useAppStore.ts` | 7, 10, 11 | `installHarness`, model flag, persist |
| `src/renderer/styles.css` | 8 | `.harness-opencode` |
