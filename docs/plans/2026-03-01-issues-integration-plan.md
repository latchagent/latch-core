# Issues → GitHub/Linear/Latch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let agents pick up tickets from GitHub Issues, Linear boards, or Latch's native task tracker. Auto-create sessions with full context (project dir, branch name, goal). Sync status/comments/PRs back bidirectionally for external providers.

**Architecture:** Provider abstraction with GitHub REST + Linear GraphQL + native SQLite. Unified Issues view with three provider tabs. Inline task creation for Latch tab. Session start confirmation dialog for all providers.

**Tech Stack:** GitHub REST API, Linear GraphQL API, SQLite (better-sqlite3), Zustand, React, Phosphor Icons

---

### Task 1: Add types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add Issue and IssueRepo types**

Add after the Checkpoint interface block:

```typescript
// ── Issues (GitHub/Linear/Latch Integration) ────────────────────────────────

export type IssueProvider = 'github' | 'linear' | 'latch'

export interface Issue {
  id: string
  provider: IssueProvider
  ref: string
  title: string
  body: string
  status: 'open' | 'in_progress' | 'done' | 'closed'
  labels: string[]
  assignee: string | null
  url: string
  repo: string
  priority?: string
  projectDir?: string
  branchName?: string
  sessionId?: string | null
  syncedAt?: string
  createdAt: string
  updatedAt: string
}

export interface IssueRepo {
  id: string
  name: string
  fullName: string
}
```

**Step 2: Add 'issues' to AppView**

Add `'issues'` to the AppView union type.

**Step 3: Add issue IPC methods to LatchAPI**

Add to the LatchAPI interface:

```typescript
// Issues
listIssueRepos(payload: { provider: string }): Promise<{ ok: boolean; repos: IssueRepo[]; error?: string }>;
listIssues(payload: { provider: string; repo: string; status?: string; labels?: string[] }): Promise<{ ok: boolean; issues: Issue[]; error?: string }>;
getIssue(payload: { provider: string; ref: string }): Promise<{ ok: boolean; issue?: Issue; error?: string }>;
createIssue(payload: { title: string; body?: string; projectDir?: string; branchName?: string; labels?: string[] }): Promise<{ ok: boolean; issue?: Issue; error?: string }>;
updateIssue(payload: { id: string; title?: string; body?: string; status?: string; projectDir?: string; branchName?: string }): Promise<{ ok: boolean; error?: string }>;
deleteIssue(payload: { id: string }): Promise<{ ok: boolean; error?: string }>;
startIssueSession(payload: { provider: string; ref: string; projectDir?: string }): Promise<{ ok: boolean; issue?: Issue; error?: string }>;
linkIssueSession(payload: { issueId: string; sessionId: string }): Promise<{ ok: boolean; error?: string }>;
syncIssue(payload: { issueId: string }): Promise<{ ok: boolean; error?: string }>;
listLinkedIssues(): Promise<{ ok: boolean; issues: Issue[]; error?: string }>;
```

**Step 4: Typecheck**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(issues): add Issue types with Latch provider, AppView, and IPC methods"
```

---

### Task 2: Create issue store

**Files:**
- Create: `src/main/stores/issue-store.ts`

**Step 1: Write IssueStore class**

Follow the same pattern as `feed-store.ts`. The store supports both external issues (GitHub/Linear) and native Latch tasks. Key additions over original plan:
- `project_dir` and `branch_name` columns for Latch native tasks
- `create()` method for native task creation with auto-generated refs (LATCH-1, LATCH-2, etc.)
- `update()` method for editing native tasks
- `nextLatchRef()` helper that queries `MAX(CAST(REPLACE(ref, 'LATCH-', '') AS INTEGER))` to generate sequential refs

```typescript
/**
 * @module issue-store
 * @description SQLite-backed persistence for GitHub/Linear/Latch issue tracking.
 * Links issues to Latch sessions for bidirectional sync.
 * Also serves as the native Latch task tracker.
 */

import type Database from 'better-sqlite3'
import type { Issue } from '../../types'

export class IssueStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): IssueStore {
    const store = new IssueStore(db)
    store._init()
    return store
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id           TEXT PRIMARY KEY,
        provider     TEXT NOT NULL,
        ref          TEXT NOT NULL,
        title        TEXT NOT NULL,
        body         TEXT,
        status       TEXT NOT NULL DEFAULT 'open',
        labels       TEXT DEFAULT '[]',
        assignee     TEXT,
        url          TEXT,
        repo         TEXT,
        priority     TEXT,
        project_dir  TEXT,
        branch_name  TEXT,
        session_id   TEXT,
        synced_at    TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )
    `)

    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_session ON issues (session_id)`) } catch { /* exists */ }
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_provider ON issues (provider, repo)`) } catch { /* exists */ }
  }

  /** Generate next LATCH-N ref. */
  nextLatchRef(): string {
    const row = this.db.prepare(
      `SELECT MAX(CAST(REPLACE(ref, 'LATCH-', '') AS INTEGER)) as maxNum FROM issues WHERE provider = 'latch'`
    ).get() as any
    const next = (row?.maxNum || 0) + 1
    return `LATCH-${next}`
  }

  /** Create a native Latch task. */
  create(params: { title: string; body?: string; projectDir?: string; branchName?: string; labels?: string[] }): Issue {
    const ref = this.nextLatchRef()
    const id = `latch:${ref}`
    const now = new Date().toISOString()
    const issue: Issue = {
      id,
      provider: 'latch',
      ref,
      title: params.title,
      body: params.body || '',
      status: 'open',
      labels: params.labels || [],
      assignee: null,
      url: '',
      repo: params.projectDir || '',
      projectDir: params.projectDir || undefined,
      branchName: params.branchName || undefined,
      createdAt: now,
      updatedAt: now,
    }
    this.save(issue)
    return issue
  }

  /** Save or update an issue from any provider. */
  save(issue: Issue): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO issues (id, provider, ref, title, body, status, labels, assignee, url, repo, priority, project_dir, branch_name, session_id, synced_at, created_at, updated_at)
      VALUES (@id, @provider, @ref, @title, @body, @status, @labels, @assignee, @url, @repo, @priority, @projectDir, @branchName, @sessionId, @syncedAt, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        title = @title, body = @body, status = @status, labels = @labels,
        assignee = @assignee, priority = @priority, project_dir = @projectDir,
        branch_name = @branchName, synced_at = @syncedAt, updated_at = @now
    `).run({
      id: issue.id,
      provider: issue.provider,
      ref: issue.ref,
      title: issue.title,
      body: issue.body || '',
      status: issue.status,
      labels: JSON.stringify(issue.labels),
      assignee: issue.assignee,
      url: issue.url || '',
      repo: issue.repo,
      priority: issue.priority || null,
      projectDir: issue.projectDir || null,
      branchName: issue.branchName || null,
      sessionId: issue.sessionId || null,
      syncedAt: issue.syncedAt || now,
      now,
    })
  }

  /** Update specific fields on a native Latch task. */
  update(id: string, fields: Partial<Pick<Issue, 'title' | 'body' | 'status' | 'projectDir' | 'branchName'>>): void {
    const sets: string[] = []
    const params: any = { id }
    if (fields.title !== undefined)      { sets.push('title = @title'); params.title = fields.title }
    if (fields.body !== undefined)       { sets.push('body = @body'); params.body = fields.body }
    if (fields.status !== undefined)     { sets.push('status = @status'); params.status = fields.status }
    if (fields.projectDir !== undefined) { sets.push('project_dir = @projectDir'); params.projectDir = fields.projectDir }
    if (fields.branchName !== undefined) { sets.push('branch_name = @branchName'); params.branchName = fields.branchName }
    if (sets.length === 0) return
    sets.push('updated_at = @now')
    params.now = new Date().toISOString()
    this.db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }

  /** List issues, optionally filtered. */
  list(opts?: { provider?: string; repo?: string; status?: string }): Issue[] {
    let sql = 'SELECT * FROM issues WHERE 1=1'
    const params: any[] = []
    if (opts?.provider) { sql += ' AND provider = ?'; params.push(opts.provider) }
    if (opts?.repo)     { sql += ' AND repo = ?'; params.push(opts.repo) }
    if (opts?.status)   { sql += ' AND status = ?'; params.push(opts.status) }
    sql += ' ORDER BY updated_at DESC'
    const rows = this.db.prepare(sql).all(...params) as any[]
    return rows.map(r => this._toIssue(r))
  }

  /** Get a single issue by id. */
  get(id: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any
    return row ? this._toIssue(row) : null
  }

  /** Link an issue to a session. */
  linkSession(issueId: string, sessionId: string): void {
    this.db.prepare('UPDATE issues SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, new Date().toISOString(), issueId)
  }

  /** Unlink an issue from its session. */
  unlinkSession(issueId: string): void {
    this.db.prepare('UPDATE issues SET session_id = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), issueId)
  }

  /** Update an issue's status. */
  updateStatus(issueId: string, status: string): void {
    this.db.prepare('UPDATE issues SET status = ?, synced_at = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), new Date().toISOString(), issueId)
  }

  /** List all issues linked to sessions. */
  listLinked(): Issue[] {
    const rows = this.db.prepare('SELECT * FROM issues WHERE session_id IS NOT NULL ORDER BY updated_at DESC').all() as any[]
    return rows.map(r => this._toIssue(r))
  }

  /** Find issue linked to a specific session. */
  findBySession(sessionId: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE session_id = ?').get(sessionId) as any
    return row ? this._toIssue(row) : null
  }

  /** Delete an issue. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
  }

  private _toIssue(row: any): Issue {
    let labels: string[] = []
    try { labels = JSON.parse(row.labels) } catch { /* default empty */ }
    return {
      id: row.id,
      provider: row.provider,
      ref: row.ref,
      title: row.title,
      body: row.body || '',
      status: row.status,
      labels,
      assignee: row.assignee,
      url: row.url,
      repo: row.repo,
      priority: row.priority,
      projectDir: row.project_dir || undefined,
      branchName: row.branch_name || undefined,
      sessionId: row.session_id,
      syncedAt: row.synced_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
```

**Step 2: Typecheck**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/main/stores/issue-store.ts
git commit -m "feat(issues): add IssueStore with native Latch task support"
```

---

### Task 3: Create GitHub provider

**Files:**
- Create: `src/main/services/github-issues.ts`

**Step 1: Write GitHub provider**

Same as original plan — REST API implementation with `githubListRepos`, `githubListIssues`, `githubGetIssue`, `githubUpdateStatus`, `githubPostComment`, `githubLinkPR` functions. Uses the existing `pr-annotator.ts` pattern for auth headers.

**Step 2: Typecheck**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/main/services/github-issues.ts
git commit -m "feat(issues): add GitHub Issues provider"
```

---

### Task 4: Create Linear provider

**Files:**
- Create: `src/main/services/linear-issues.ts`

**Step 1: Write Linear provider**

GraphQL-based provider with `linearListRepos`, `linearListIssues`, `linearGetIssue`, `linearUpdateStatus`, `linearPostComment`, `linearLinkPR` functions.

**Step 2: Typecheck**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/main/services/linear-issues.ts
git commit -m "feat(issues): add Linear Issues provider"
```

---

### Task 5: Create issue sync service

**Files:**
- Create: `src/main/services/issue-sync.ts`

**Step 1: Write issue sync service**

Event-driven sync for external providers (GitHub/Linear only, not Latch native). Functions:
- `startIssueSync()` / `stopIssueSync()` — lifecycle
- `issueSyncOnSessionStart()` — mark in_progress, post comment
- `issueSyncOnCheckpoint()` — post progress comment
- `issueSyncOnPR()` — link PR to issue
- `issueSyncOnSessionEnd()` — mark done, post comment

Skips sync for `provider === 'latch'` (native tasks update directly in store).

**Step 2: Typecheck**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/main/services/issue-sync.ts
git commit -m "feat(issues): add bidirectional issue sync service"
```

---

### Task 6: Wire IPC handlers and store into main process

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Add imports in main/index.ts**

```typescript
import { IssueStore }                            from './stores/issue-store'
import { startIssueSync, stopIssueSync, issueSyncOnSessionStart } from './services/issue-sync'
import { githubListRepos, githubListIssues, githubGetIssue } from './services/github-issues'
import { linearListRepos, linearListIssues, linearGetIssue } from './services/linear-issues'
```

**Step 2: Add singleton and init**

```typescript
let issueStore: IssueStore | null = null
// In app.whenReady():
issueStore = IssueStore.open(db)
startIssueSync({ issueStore: issueStore!, secretStore: secretStore! })
```

**Step 3: Add IPC handlers**

10 handlers:
- `latch:issue-list-repos` — delegates to githubListRepos/linearListRepos; for 'latch', returns distinct project dirs from issue store
- `latch:issue-list` — delegates to providers; for 'latch', queries issue store directly
- `latch:issue-get` — delegates to providers; for 'latch', queries issue store
- `latch:issue-create` — calls `issueStore.create()` (Latch native only)
- `latch:issue-update` — calls `issueStore.update()` (Latch native only)
- `latch:issue-delete` — calls `issueStore.delete()` (Latch native only)
- `latch:issue-start-session` — fetches full issue from provider, saves to store, returns issue data
- `latch:issue-link-session` — calls `issueStore.linkSession()`
- `latch:issue-sync` — re-fetches from provider, updates store
- `latch:issue-linked` — returns all linked issues

**Step 4: Add cleanup**

```typescript
stopIssueSync()  // in before-quit
```

**Step 5: Add preload bridges**

10 bridges in `src/preload/index.ts` matching the IPC handlers.

**Step 6: Typecheck**

Run: `npx tsc --noEmit`

**Step 7: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat(issues): wire IPC handlers and store into main process"
```

---

### Task 7: Add issues state and actions to Zustand store

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Add state and actions**

State fields:
```typescript
issuesProvider: IssueProvider    // 'github' | 'linear' | 'latch'
issuesRepos: IssueRepo[]
issuesSelectedRepo: string | null
issuesList: Issue[]
issuesLinked: Issue[]
issuesLoading: boolean
issuesError: string | null
issueStartDialogIssue: Issue | null    // issue pending session start confirmation
issueStartProjectDir: string | null
issueStartBranchName: string
```

Actions:
```typescript
setIssuesProvider: (provider) => void
loadIssueRepos: () => Promise<void>
loadIssues: (repo: string) => Promise<void>
loadLinkedIssues: () => Promise<void>
createLatchTask: (params: { title: string; body?: string; projectDir?: string; branchName?: string }) => Promise<void>
deleteLatchTask: (id: string) => Promise<void>
openIssueStartDialog: (issue: Issue) => void
closeIssueStartDialog: () => void
confirmIssueStart: () => Promise<void>   // creates session from issueStartDialogIssue
setIssueStartProjectDir: (dir: string | null) => void
setIssueStartBranchName: (name: string) => void
```

Key detail: `confirmIssueStart` creates the session, links the issue, sets the goal to issue body, sets pendingProjectDir, activates session, then clears the dialog.

**Step 2: Typecheck**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat(issues): add issues state with start dialog and Latch task CRUD"
```

---

### Task 8: Create IssuesView component

**Files:**
- Create: `src/renderer/components/IssuesView.tsx`

**Step 1: Write the IssuesView component**

Key sections:
1. **Header** — "Issues" title with subtitle
2. **Provider tabs** — GitHub | Linear | Latch (highlight active)
3. **GitHub/Linear tab content:**
   - Repo dropdown picker
   - Issue cards from API with "Start Session" button
4. **Latch tab content:**
   - "+ New Task" button that toggles inline creation form
   - Form: title input, description textarea, project dir (folder picker button using `window.latch.pickDirectory()`), branch name input, Create button
   - Task cards with status, project dir, "Start Session" button, delete button
5. **Session Start Dialog** (shown when `issueStartDialogIssue` is set):
   - Overlay/inline dialog with:
   - Project directory field + folder picker
   - Branch name input (pre-filled from issue ref or Latch task's branchName)
   - Goal preview (from issue body, read-only)
   - Confirm / Cancel buttons
6. **Active Issues section** — linked issues at bottom

**Step 2: Typecheck**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/renderer/components/IssuesView.tsx
git commit -m "feat(issues): create IssuesView with Latch tasks and start dialog"
```

---

### Task 9: Wire into Sidebar, App router, and CSS

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Add Issues to Sidebar**

Import `Ticket` from `@phosphor-icons/react`. Add button after MCP in "Build" section.

**Step 2: Add Issues to App router**

Import `IssuesView`. Add `activeView === 'issues'` route case.

**Step 3: Add CSS**

Styles for:
- `.issues-view` — layout, padding, max-width
- `.issues-provider-tabs` — tab bar with three tabs
- `.issues-repo-picker` — dropdown
- `.issue-card` — card with header, title, labels, footer, start button
- `.issues-create-form` — inline task creation form for Latch tab
- `.issue-start-dialog` — overlay confirmation dialog with project dir + branch fields
- `.issues-linked-section` — active issues at bottom
- Error, loading, empty states

**Step 4: Typecheck**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(issues): wire IssuesView into sidebar, router, and CSS"
```

---

### Task 10: Final typecheck and verification

**Step 1: Full typecheck**

Run: `npx tsc --noEmit`

Fix any remaining issues.

**Step 2: Verify all files exist**

```bash
ls -la src/main/stores/issue-store.ts
ls -la src/main/services/github-issues.ts
ls -la src/main/services/linear-issues.ts
ls -la src/main/services/issue-sync.ts
ls -la src/renderer/components/IssuesView.tsx
```

**Step 3: Commit any remaining fixes**

```bash
git add -A
git commit -m "feat(issues): final typecheck and cleanup"
```
