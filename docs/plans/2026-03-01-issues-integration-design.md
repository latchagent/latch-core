# Phase 7: Issues → GitHub/Linear/Latch — Design

**Goal:** Let agents pick up tickets from GitHub Issues, Linear boards, or Latch's native task tracker. Auto-create sessions with full context (project dir, branch name, goal), and sync status/comments/PRs back bidirectionally for external providers.

**Architecture:** Provider abstraction with GitHub REST, Linear GraphQL, and native Latch SQLite implementations. Unified Issues view with three provider tabs. Session start confirmation dialog for project dir + branch selection.

**Tech Stack:** GitHub REST API, Linear GraphQL API, SQLite, Zustand, Phosphor Icons

---

## Provider Layer

Three providers behind a common interface:

```typescript
interface IssueProvider {
  id: 'github' | 'linear' | 'latch'
  listRepos(): Promise<{ id: string; name: string }[]>
  listIssues(opts: { repo: string; labels?: string[]; status?: string }): Promise<Issue[]>
  getIssue(ref: string): Promise<Issue>
  updateStatus(ref: string, status: string): Promise<void>
  postComment(ref: string, body: string): Promise<void>
  linkPR(ref: string, prUrl: string): Promise<void>
}
```

### GitHub Provider
- Uses REST API directly (same pattern as `pr-annotator.ts`)
- Credentials from SecretStore via `service:github` token
- Repo listing via `GET /user/repos`
- Issues via `GET /repos/{owner}/{repo}/issues`
- Status mapping: open → open, closed → done
- Comments via `POST /repos/{owner}/{repo}/issues/{number}/comments`
- PR linking via comment body (GitHub auto-links referenced issues)

### Linear Provider
- Uses GraphQL API (`https://api.linear.app/graphql`)
- Credentials from SecretStore via `service:linear` API key
- Project listing via `teams { projects { ... } }` query
- Issues via `issues(filter: { project: { id: { eq: $projectId } } })` query
- Status mapping: maps Linear workflow states → open/in_progress/done/closed
- Comments via `commentCreate` mutation
- PR linking via `attachmentLinkURL` mutation

### Latch Provider (Native)
- No external API — reads/writes directly to the issues SQLite table
- No credentials needed
- Users create tasks inline with: title, description, project dir, branch name
- Refs are auto-generated: `LATCH-1`, `LATCH-2`, etc.
- Status managed locally: open → in_progress → done → closed
- No sync needed — status updates happen directly in the store
- "Repos" are project directories (groups tasks by project dir)

### Common Issue Type

```typescript
interface Issue {
  id: string               // provider-scoped unique id
  provider: 'github' | 'linear' | 'latch'
  ref: string              // display ref: 'owner/repo#42', 'PROJ-123', or 'LATCH-1'
  title: string
  body: string             // markdown description
  status: 'open' | 'in_progress' | 'done' | 'closed'
  labels: string[]
  assignee: string | null
  url: string              // web URL (empty for latch tasks)
  repo: string             // github: 'owner/repo', linear: team key, latch: project dir
  priority?: string        // linear: urgent/high/medium/low
  projectDir?: string      // filesystem path (used by latch tasks, optional for external)
  branchName?: string      // suggested branch name (used by latch tasks)
  sessionId?: string | null
  syncedAt?: string
  createdAt: string
  updatedAt: string
}
```

---

## Issue Store (SQLite)

New `issue-store.ts` following the same pattern as `feed-store.ts`:

```sql
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  labels TEXT DEFAULT '[]',
  assignee TEXT,
  url TEXT,
  repo TEXT,
  priority TEXT,
  session_id TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_session ON issues (session_id);
CREATE INDEX IF NOT EXISTS idx_issues_provider ON issues (provider, repo);
```

Methods: `save()`, `list()`, `get()`, `linkSession()`, `unlinkSession()`, `updateStatus()`, `listLinked()`, `delete()`

---

## Issue Sync Service

Event-driven background service (not polling). Reacts to session lifecycle events via feed items:

| Session Event | Sync Action |
|---------------|-------------|
| Session created from issue | Update issue status → "In Progress" |
| Checkpoint created | Post progress comment (summary + files changed) |
| PR detected (git push to remote) | Link PR to issue via comment/attachment |
| Session ended (clean exit) | Update status → "Done" / "In Review" |

The sync service registers as a feed listener. When a feed item arrives that references a session linked to an issue, it triggers the appropriate provider action.

```typescript
function startIssueSync(opts: {
  issueStore: IssueStore
  providers: Map<string, IssueProvider>
  secretStore: SecretStore
}): { dispose: () => void }
```

---

## Issues View (UI)

New sidebar view under "Build" section with `Ticket` icon.

### Layout
Single column:
- **Provider tabs** — GitHub | Linear | Latch toggle at top
- **For GitHub/Linear tabs:**
  - Repo/Project picker dropdown
  - Issue cards from API
- **For Latch tab:**
  - "+ New Task" button that expands an inline creation form
  - Form fields: title, description (textarea), project dir (folder picker), branch name
  - Task cards showing existing Latch tasks grouped by status
- **All tabs:**
  - Issue/task cards with status badge, "Start Session" button
  - Active Issues section pinned at bottom

### Session Start Confirmation Dialog
When clicking "Start Session" on any issue (GitHub, Linear, or Latch), a small inline dialog appears with:
- **Project directory** — folder picker (pre-filled from Latch task or empty for external)
- **Branch name** — text input (pre-filled from Latch task or auto-generated from issue ref)
- **Goal** — pre-filled from issue body (editable)
- **Confirm / Cancel** buttons

This replaces the full session wizard — it's a lightweight confirmation step.

### Session Creation Flow
1. User clicks "Start Session" on any issue card
2. Confirmation dialog appears with project dir + branch name fields
3. User confirms → Latch creates session with full context
4. Issue is linked in issue-store
5. For external providers: sync service pushes "In Progress" status
6. Session activates and agent begins with full ticket context

### Sidebar Position
Under "Build" section, after MCP:
- Agents
- MCP
- **Issues** ← new

---

## IPC Channels

```
latch:issue-list-repos    { provider }                    → { repos[] }
latch:issue-list          { provider, repo, filters? }    → { issues[] }
latch:issue-get           { provider, ref }               → { issue }
latch:issue-create        { title, body, projectDir, branchName } → { issue }
latch:issue-update        { id, ...fields }               → { ok }
latch:issue-delete        { id }                          → { ok }
latch:issue-start-session { provider, ref, projectDir? }  → { issue }
latch:issue-link-session  { issueId, sessionId }          → { ok }
latch:issue-sync          { issueId }                     → { ok }
latch:issue-linked        {}                              → { issues[] }
```

---

## File Plan

| File | Action |
|------|--------|
| `src/types/index.ts` | Add Issue types with projectDir/branchName, 'issues' to AppView, IPC methods |
| `src/main/services/github-issues.ts` | GitHub provider implementation |
| `src/main/services/linear-issues.ts` | Linear provider implementation |
| `src/main/stores/issue-store.ts` | SQLite CRUD for issues table (supports native Latch tasks) |
| `src/main/services/issue-sync.ts` | Background sync service (external providers only) |
| `src/main/index.ts` | Wire IPC handlers, init store + sync |
| `src/preload/index.ts` | Bridge IPC channels |
| `src/renderer/store/useAppStore.ts` | Issues state + actions (including native task CRUD) |
| `src/renderer/components/IssuesView.tsx` | Issues view with GitHub/Linear/Latch tabs, task creation, start dialog |
| `src/renderer/components/Sidebar.tsx` | Add Issues nav item |
| `src/renderer/App.tsx` | Add Issues route |
| `src/renderer/styles.css` | Issues view styles |
