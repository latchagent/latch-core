# Observability Phase 2 — Session Timeline / Replay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a visual session timeline that replays every agent action in a conversation — tool calls, thinking, responses — as color-coded nodes on a horizontal scrubbable strip with cost/duration annotations.

**Architecture:** A main-process `TimelineParser` reads JSONL conversation files on-demand (no new store — the JSONL files ARE the data), extracts per-turn details (tool name, input/result summaries, thinking, durations, costs), and returns structured `TimelineTurn` arrays via IPC. The renderer shows a `TimelineView` with a project/conversation browser, a horizontal scrollable timeline strip of color-coded action nodes, and a detail panel for the selected turn. Reuses the existing JSONL file locations, pricing engine, and CSS design system from Phase 1.

**Tech Stack:** TypeScript, Electron IPC, Node.js fs, React 18, Zustand, Phosphor Icons, pure CSS/SVG

---

## Task 1: Types + Action Classifier

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/main/lib/timeline-classifier.ts`

**Step 1: Add timeline types to `src/types/index.ts`**

After the `UsageSummary` interface (around line 656), add:

```typescript
// ─── Timeline (Phase 2) ─────────────────────────────────────────────────────

export type TimelineActionType = 'read' | 'write' | 'bash' | 'search' | 'agent' | 'error' | 'respond'

export interface TimelineToolCall {
  name: string
  id: string
  inputSummary: string
  resultSummary: string | null
  isError: boolean
}

export interface TimelineTurn {
  index: number
  requestId: string | null
  timestamp: string
  durationMs: number | null
  model: string
  stopReason: string | null
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  thinkingSummary: string | null
  textSummary: string | null
  toolCalls: TimelineToolCall[]
  actionType: TimelineActionType
}

export interface TimelineConversation {
  id: string
  filePath: string
  projectSlug: string
  projectName: string
  lastModified: string
  sizeBytes: number
}

export interface TimelineData {
  conversation: TimelineConversation
  turns: TimelineTurn[]
  totalCostUsd: number
  totalDurationMs: number
  turnCount: number
  models: string[]
}
```

**Step 2: Add `'timeline'` to the `AppView` type**

Find the `AppView` type union (around line 680) and add `'timeline'`:

```typescript
export type AppView = 'home' | 'policies' | 'agents' | 'mcp' | 'feed' | 'radar' | 'usage' | 'timeline' | 'docs' | /* ... rest */
```

**Step 3: Add timeline IPC methods to `LatchAPI`**

In the `LatchAPI` interface, after the usage methods:

```typescript
  // Timeline
  listTimelineConversations(payload: { projectSlug?: string }): Promise<{ ok: boolean; conversations: TimelineConversation[] }>;
  loadTimeline(payload: { filePath: string }): Promise<{ ok: boolean; data: TimelineData | null; error?: string }>;
```

**Step 4: Create the action classifier**

```typescript
// src/main/lib/timeline-classifier.ts

/**
 * @module timeline-classifier
 * @description Classifies tool names into action types for timeline color-coding.
 */

import type { TimelineActionType } from '../../types'

const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TaskList', 'TaskGet',
])

const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'NotebookEdit', 'TaskCreate', 'TaskUpdate',
])

const BASH_TOOLS = new Set([
  'Bash',
])

const SEARCH_TOOLS = new Set([
  'WebSearch', 'Grep', 'Glob',
])

const AGENT_TOOLS = new Set([
  'Agent', 'Skill', 'SendMessage', 'EnterPlanMode', 'ExitPlanMode',
])

/**
 * Classify a tool name into an action type.
 * If the tool result was an error, always returns 'error'.
 */
export function classifyAction(toolName: string | null, isError: boolean): TimelineActionType {
  if (isError) return 'error'
  if (!toolName) return 'respond'
  if (AGENT_TOOLS.has(toolName)) return 'agent'
  if (BASH_TOOLS.has(toolName)) return 'bash'
  if (WRITE_TOOLS.has(toolName)) return 'write'
  if (SEARCH_TOOLS.has(toolName)) return 'search'
  if (READ_TOOLS.has(toolName)) return 'read'
  return 'respond'
}

/** Color mapping for each action type — using CSS variable names */
export const ACTION_COLORS: Record<TimelineActionType, string> = {
  read:    'rgb(var(--d-blue))',
  write:   'rgb(var(--d-green))',
  bash:    'rgb(var(--d-yellow))',
  search:  'rgb(var(--d-blue))',
  agent:   'rgb(var(--d-purple, 168 85 247))',
  error:   'var(--error)',
  respond: 'var(--text-tertiary)',
}
```

**Step 5: Commit**

```bash
git add src/types/index.ts src/main/lib/timeline-classifier.ts
git commit -m "feat(timeline): add timeline types and action classifier"
```

---

## Task 2: Timeline Parser

**Files:**
- Create: `src/main/lib/timeline-parser.ts`

**Step 1: Create the timeline parser**

This is the core logic — reads a JSONL file and extracts structured timeline turns.

```typescript
// src/main/lib/timeline-parser.ts

/**
 * @module timeline-parser
 * @description Parses Claude Code JSONL conversation files into structured
 * timeline turns. Handles streaming deduplication (multiple entries per requestId),
 * matches tool_use blocks to tool_result blocks, and calculates per-turn costs.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { classifyAction } from './timeline-classifier'
import { normalizeModelId, calculateCost } from './pricing'
import type { TimelineTurn, TimelineToolCall, TimelineConversation, TimelineData, TimelineActionType } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function summarize(text: string | null | undefined, maxLen = 200): string | null {
  if (!text) return null
  const clean = text.trim()
  if (!clean) return null
  return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean
}

function toolInputSummary(name: string, input: Record<string, unknown>): string {
  // Show the most relevant input field for common tools
  if (name === 'Read' || name === 'Write') return String(input.file_path ?? input.filePath ?? '')
  if (name === 'Edit') return String(input.file_path ?? input.filePath ?? '')
  if (name === 'Glob') return String(input.pattern ?? '')
  if (name === 'Grep') return String(input.pattern ?? '')
  if (name === 'Bash') return summarize(String(input.command ?? ''), 120) ?? ''
  if (name === 'WebSearch') return String(input.query ?? '')
  if (name === 'WebFetch') return String(input.url ?? '')
  if (name === 'Agent') return summarize(String(input.prompt ?? ''), 120) ?? ''
  // Generic: show first string-valued key
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0) return summarize(v, 120) ?? ''
  }
  return ''
}

// ── Conversation listing ────────────────────────────────────────────────────

/**
 * List all JSONL conversation files in Claude projects directory.
 * Optionally filter to a single project slug.
 */
export function listConversations(projectSlug?: string): TimelineConversation[] {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeBase)) return []

  const conversations: TimelineConversation[] = []
  const slugs = projectSlug ? [projectSlug] : (() => {
    try { return fs.readdirSync(claudeBase) } catch { return [] }
  })()

  for (const slug of slugs) {
    const dirPath = path.join(claudeBase, slug)
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue
    } catch { continue }

    // Extract readable project name from slug (last path component)
    const parts = slug.split('-').filter(Boolean)
    const projectName = parts[parts.length - 1] ?? slug

    let files: string[]
    try { files = fs.readdirSync(dirPath) } catch { continue }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(dirPath, file)
      try {
        const stat = fs.statSync(filePath)
        // Skip tiny files (< 1KB) — probably empty/corrupt
        if (stat.size < 1024) continue
        conversations.push({
          id: file.replace('.jsonl', ''),
          filePath,
          projectSlug: slug,
          projectName,
          lastModified: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        })
      } catch { continue }
    }
  }

  // Sort by last modified descending
  conversations.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
  return conversations
}

// ── Timeline parsing ────────────────────────────────────────────────────────

interface RawAssistantEntry {
  requestId: string | null
  timestamp: string
  model: string
  stopReason: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
  thinkingText: string | null
  responseText: string | null
  toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }>
}

interface RawToolResult {
  toolUseId: string
  content: string
  isError: boolean
}

/**
 * Parse a JSONL conversation file into structured timeline data.
 */
export function parseTimeline(filePath: string): TimelineData {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n').filter((l) => l.trim())

  // Phase 1: Extract raw entries
  const assistantsByReqId = new Map<string, RawAssistantEntry>()
  const assistantsByOrder: RawAssistantEntry[] = []
  const toolResults = new Map<string, RawToolResult>() // keyed by tool_use_id

  for (const line of lines) {
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    if (obj.type === 'assistant' && obj.message?.usage) {
      const msg = obj.message
      const usage = msg.usage ?? {}

      // Extract content blocks
      let thinkingText: string | null = null
      let responseText: string | null = null
      const toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }> = []

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'thinking' && block.thinking) {
            thinkingText = block.thinking
          } else if (block.type === 'text' && block.text) {
            responseText = block.text
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              name: block.name ?? 'unknown',
              id: block.id ?? '',
              input: block.input ?? {},
            })
          }
        }
      }

      const entry: RawAssistantEntry = {
        requestId: obj.requestId ?? null,
        timestamp: obj.timestamp ?? new Date().toISOString(),
        model: msg.model ?? 'unknown',
        stopReason: msg.stop_reason ?? null,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        },
        thinkingText,
        responseText,
        toolCalls,
      }

      // Dedup: keep last entry per requestId (last chunk has final token counts)
      if (entry.requestId) {
        assistantsByReqId.set(entry.requestId, entry)
      } else {
        assistantsByOrder.push(entry)
      }
    }

    if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_result') {
          let resultText = ''
          if (typeof block.content === 'string') {
            resultText = block.content
          } else if (Array.isArray(block.content)) {
            resultText = block.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text ?? '')
              .join('\n')
          }
          toolResults.set(block.tool_use_id, {
            toolUseId: block.tool_use_id,
            content: resultText,
            isError: block.is_error === true,
          })
        }
      }
    }
  }

  // Merge deduped entries back, maintaining order by timestamp
  const allEntries = [
    ...assistantsByReqId.values(),
    ...assistantsByOrder,
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // Phase 2: Build timeline turns
  const turns: TimelineTurn[] = []
  let totalCost = 0
  const modelsSet = new Set<string>()

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i]
    const normalizedModel = normalizeModelId(entry.model)
    modelsSet.add(normalizedModel)

    // Calculate cost
    const costUsd = calculateCost({
      inputTokens: entry.usage.input_tokens,
      outputTokens: entry.usage.output_tokens,
      cacheWriteTokens: entry.usage.cache_creation_input_tokens,
      cacheReadTokens: entry.usage.cache_read_input_tokens,
    }, entry.model)
    totalCost += costUsd

    // Calculate duration to next turn
    let durationMs: number | null = null
    if (i < allEntries.length - 1) {
      const nextTs = new Date(allEntries[i + 1].timestamp).getTime()
      const thisTs = new Date(entry.timestamp).getTime()
      durationMs = nextTs - thisTs
      if (durationMs < 0) durationMs = null
    }

    // Build tool calls with results
    const timelineToolCalls: TimelineToolCall[] = entry.toolCalls.map((tc) => {
      const result = toolResults.get(tc.id)
      return {
        name: tc.name,
        id: tc.id,
        inputSummary: toolInputSummary(tc.name, tc.input),
        resultSummary: result ? summarize(result.content, 200) : null,
        isError: result?.isError ?? false,
      }
    })

    // Determine action type from primary tool call
    const primaryTool = timelineToolCalls[0]
    const hasError = timelineToolCalls.some((tc) => tc.isError)
    const actionType: TimelineActionType = classifyAction(
      primaryTool?.name ?? null,
      hasError,
    )

    turns.push({
      index: i,
      requestId: entry.requestId,
      timestamp: entry.timestamp,
      durationMs,
      model: normalizedModel,
      stopReason: entry.stopReason,
      costUsd,
      inputTokens: entry.usage.input_tokens,
      outputTokens: entry.usage.output_tokens,
      cacheReadTokens: entry.usage.cache_read_input_tokens,
      cacheWriteTokens: entry.usage.cache_creation_input_tokens,
      thinkingSummary: summarize(entry.thinkingText),
      textSummary: summarize(entry.responseText),
      toolCalls: timelineToolCalls,
      actionType,
    })
  }

  // Calculate total duration from first to last turn
  let totalDurationMs = 0
  if (turns.length >= 2) {
    const first = new Date(turns[0].timestamp).getTime()
    const last = new Date(turns[turns.length - 1].timestamp).getTime()
    totalDurationMs = last - first
  }

  // Build conversation metadata from file path
  const dirName = path.basename(path.dirname(filePath))
  const parts = dirName.split('-').filter(Boolean)
  const projectName = parts[parts.length - 1] ?? dirName

  return {
    conversation: {
      id: path.basename(filePath, '.jsonl'),
      filePath,
      projectSlug: dirName,
      projectName,
      lastModified: (() => { try { return fs.statSync(filePath).mtime.toISOString() } catch { return new Date().toISOString() } })(),
      sizeBytes: (() => { try { return fs.statSync(filePath).size } catch { return 0 } })(),
    },
    turns,
    totalCostUsd: totalCost,
    totalDurationMs,
    turnCount: turns.length,
    models: Array.from(modelsSet),
  }
}
```

**Step 2: Commit**

```bash
git add src/main/lib/timeline-parser.ts
git commit -m "feat(timeline): add JSONL timeline parser with turn extraction and cost calculation"
```

---

## Task 3: IPC Handlers

**Files:**
- Modify: `src/main/index.ts`

**Step 1: Add timeline imports**

At the top of `src/main/index.ts`, with the other imports:

```typescript
import { listConversations, parseTimeline } from './lib/timeline-parser'
```

**Step 2: Add IPC handlers**

After the usage IPC handlers (around line 860), add:

```typescript
  // ── Timeline ─────────────────────────────────────────────────────────────

  ipcMain.handle('latch:timeline-conversations', async (_event: any, payload: any = {}) => {
    try {
      const conversations = listConversations(payload.projectSlug)
      return { ok: true, conversations }
    } catch (err: unknown) {
      return { ok: false, conversations: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('latch:timeline-load', async (_event: any, payload: any = {}) => {
    if (!payload.filePath) return { ok: false, data: null, error: 'filePath required' }
    try {
      const data = parseTimeline(payload.filePath)
      return { ok: true, data }
    } catch (err: unknown) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) }
    }
  })
```

**Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(timeline): add timeline IPC handlers for conversation listing and parsing"
```

---

## Task 4: Preload Bridge

**Files:**
- Modify: `src/preload/index.ts`

**Step 1: Add timeline IPC methods**

After the usage methods in the `contextBridge.exposeInMainWorld` call, add:

```typescript
    // Timeline
    listTimelineConversations: (payload?: { projectSlug?: string }) =>
      ipcRenderer.invoke('latch:timeline-conversations', payload ?? {}),
    loadTimeline: (payload: { filePath: string }) =>
      ipcRenderer.invoke('latch:timeline-load', payload),
```

**Step 2: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(timeline): add timeline preload bridge methods"
```

---

## Task 5: Zustand Store

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Add imports**

Add to the existing type imports from `../../types`:

```typescript
import type { ..., TimelineConversation, TimelineData, TimelineTurn } from '../../types'
```

**Step 2: Add state fields**

In the state interface, after the usage fields:

```typescript
  // Timeline
  timelineConversations: TimelineConversation[];
  timelineData: TimelineData | null;
  timelineSelectedTurn: number | null;
  timelineLoading: boolean;
```

**Step 3: Add action signatures**

In the actions section:

```typescript
  // Timeline
  loadTimelineConversations: (projectSlug?: string) => Promise<void>;
  loadTimeline:              (filePath: string) => Promise<void>;
  setTimelineSelectedTurn:   (index: number | null) => void;
```

**Step 4: Add initial state**

In the `create` call:

```typescript
  timelineConversations: [],
  timelineData: null,
  timelineSelectedTurn: null,
  timelineLoading: false,
```

**Step 5: Add action implementations**

After the usage actions:

```typescript
  // ── Timeline ───────────────────────────────────────────────────────────

  loadTimelineConversations: async (projectSlug?: string) => {
    const result = await window.latch?.listTimelineConversations?.({ projectSlug })
    if (result?.ok) {
      set({ timelineConversations: result.conversations })
    }
  },

  loadTimeline: async (filePath: string) => {
    set({ timelineLoading: true, timelineSelectedTurn: null })
    const result = await window.latch?.loadTimeline?.({ filePath })
    set({
      timelineData: result?.data ?? null,
      timelineLoading: false,
    })
  },

  setTimelineSelectedTurn: (index: number | null) => {
    set({ timelineSelectedTurn: index })
  },
```

**Step 6: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat(timeline): add timeline state and actions to Zustand store"
```

---

## Task 6: App.tsx + Sidebar Wiring

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`

**Step 1: Add TimelineView import in App.tsx**

```typescript
import TimelineView from './components/TimelineView'
```

**Step 2: Add timeline route in App.tsx**

After the usage route:

```typescript
  } else if (activeView === 'timeline') {
    mainContent = <TimelineView />
```

**Step 3: Add Timeline nav item in Sidebar.tsx**

Import the icon:

```typescript
import { Terminal, Broadcast, Lock, Robot, HardDrives, Gear, BookOpenText, Target, Plugs, ShieldCheck, ChartBar, GitBranch } from '@phosphor-icons/react'
```

After the Usage button in the OBSERVE section, add:

```tsx
        <button
          className={`sidebar-nav-item${activeView === 'timeline' ? ' is-active' : ''}`}
          onClick={() => setActiveView('timeline')}
        >
          <GitBranch className="sidebar-nav-icon" weight="light" />
          Timeline
        </button>
```

**Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/Sidebar.tsx
git commit -m "feat(timeline): wire timeline view route and sidebar nav item"
```

---

## Task 7: TimelineView Component + CSS

**Files:**
- Create: `src/renderer/components/TimelineView.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Create the TimelineView component**

```tsx
// src/renderer/components/TimelineView.tsx

/**
 * @module TimelineView
 * @description Session timeline replay — visualizes every agent action as
 * color-coded nodes on a horizontal strip with cost/duration annotations.
 */

import React, { useEffect, useMemo, useRef } from 'react'
import { GitBranch } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { TimelineTurn, TimelineActionType } from '../../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDate(timestamp: string): string {
  const d = new Date(timestamp)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)}KB`
  return `${bytes}B`
}

const ACTION_COLORS: Record<TimelineActionType, string> = {
  read:    'rgb(var(--d-blue))',
  write:   'rgb(var(--d-green))',
  bash:    'rgb(var(--d-yellow))',
  search:  'rgb(var(--d-blue))',
  agent:   'rgb(168, 85, 247)',
  error:   'var(--error)',
  respond: 'var(--text-tertiary)',
}

const ACTION_LABELS: Record<TimelineActionType, string> = {
  read: 'Read', write: 'Write', bash: 'Bash', search: 'Search',
  agent: 'Agent', error: 'Error', respond: 'Response',
}

// ── Component ───────────────────────────────────────────────────────────────

export default function TimelineView() {
  const {
    timelineConversations,
    timelineData,
    timelineSelectedTurn,
    timelineLoading,
    loadTimelineConversations,
    loadTimeline,
    setTimelineSelectedTurn,
  } = useAppStore()

  const stripRef = useRef<HTMLDivElement>(null)

  // Load conversations on mount
  useEffect(() => {
    loadTimelineConversations()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Action type distribution for summary
  const actionCounts = useMemo(() => {
    if (!timelineData) return {}
    const counts: Partial<Record<TimelineActionType, number>> = {}
    for (const turn of timelineData.turns) {
      counts[turn.actionType] = (counts[turn.actionType] ?? 0) + 1
    }
    return counts
  }, [timelineData])

  const selectedTurn = useMemo(() => {
    if (timelineSelectedTurn === null || !timelineData) return null
    return timelineData.turns[timelineSelectedTurn] ?? null
  }, [timelineData, timelineSelectedTurn])

  // ── Conversation list ───────────────────────────────────────────────

  if (!timelineData) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h1 className="view-title">Timeline</h1>
        </div>

        {timelineLoading ? (
          <div className="tl-empty">
            <span className="tl-empty-text">Loading timeline...</span>
          </div>
        ) : timelineConversations.length === 0 ? (
          <div className="tl-empty">
            <GitBranch size={48} weight="light" className="tl-empty-icon" />
            <span className="tl-empty-text">No conversations found</span>
            <span className="tl-empty-hint">
              Claude Code conversation logs from ~/.claude/projects/ will appear here.
            </span>
          </div>
        ) : (
          <div className="tl-conversation-list">
            {timelineConversations.map((conv) => (
              <button
                key={conv.id}
                className="tl-conversation-item"
                onClick={() => loadTimeline(conv.filePath)}
              >
                <div className="tl-conv-top">
                  <span className="tl-conv-project">{conv.projectName}</span>
                  <span className="tl-conv-date">{formatDate(conv.lastModified)}</span>
                </div>
                <div className="tl-conv-bottom">
                  <span className="tl-conv-id">{conv.id.slice(0, 8)}…</span>
                  <span className="tl-conv-size">{formatSize(conv.sizeBytes)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Timeline view ───────────────────────────────────────────────────

  const { turns } = timelineData

  return (
    <div className="view-container">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="view-header">
        <h1 className="view-title">Timeline</h1>
        <div className="view-header-actions">
          <button
            className="view-action-btn"
            onClick={() => {
              useAppStore.setState({ timelineData: null, timelineSelectedTurn: null })
            }}
          >
            Back
          </button>
        </div>
      </div>

      {/* ── Summary stats ──────────────────────────────────────── */}
      <div className="tl-summary">
        <div className="tl-summary-item">
          <span className="tl-summary-value">{timelineData.turnCount}</span>
          <span className="tl-summary-label">turns</span>
        </div>
        <div className="tl-summary-item">
          <span className="tl-summary-value">{formatCost(timelineData.totalCostUsd)}</span>
          <span className="tl-summary-label">cost</span>
        </div>
        <div className="tl-summary-item">
          <span className="tl-summary-value">{formatDuration(timelineData.totalDurationMs)}</span>
          <span className="tl-summary-label">duration</span>
        </div>
        <div className="tl-summary-item">
          <span className="tl-summary-value">{timelineData.models.join(', ')}</span>
          <span className="tl-summary-label">model</span>
        </div>
      </div>

      {/* ── Action type legend ─────────────────────────────────── */}
      <div className="tl-legend">
        {(Object.entries(actionCounts) as [TimelineActionType, number][]).map(([type, count]) => (
          <span key={type} className="tl-legend-item">
            <span className="tl-legend-dot" style={{ background: ACTION_COLORS[type] }} />
            {ACTION_LABELS[type]} {count}
          </span>
        ))}
      </div>

      {/* ── Timeline strip ─────────────────────────────────────── */}
      <div className="tl-strip-container">
        <div className="tl-strip" ref={stripRef}>
          {turns.map((turn) => (
            <button
              key={turn.index}
              className={`tl-node${timelineSelectedTurn === turn.index ? ' is-selected' : ''}`}
              style={{ '--node-color': ACTION_COLORS[turn.actionType] } as React.CSSProperties}
              title={`#${turn.index + 1} ${turn.toolCalls[0]?.name ?? 'Response'} ${formatCost(turn.costUsd)}`}
              onClick={() => setTimelineSelectedTurn(turn.index)}
            >
              <span className="tl-node-dot" />
              {turn.costUsd >= 0.10 && (
                <span className="tl-node-cost">{formatCost(turn.costUsd)}</span>
              )}
            </button>
          ))}
        </div>
        {/* Time markers */}
        {turns.length > 0 && (
          <div className="tl-time-markers">
            <span>{formatTime(turns[0].timestamp)}</span>
            {turns.length > 2 && (
              <span>{formatTime(turns[Math.floor(turns.length / 2)].timestamp)}</span>
            )}
            <span>{formatTime(turns[turns.length - 1].timestamp)}</span>
          </div>
        )}
      </div>

      {/* ── Detail panel ───────────────────────────────────────── */}
      {selectedTurn ? (
        <TurnDetail turn={selectedTurn} />
      ) : (
        <div className="tl-detail-empty">
          Click a node above to see turn details
        </div>
      )}
    </div>
  )
}

// ── Turn Detail Sub-component ───────────────────────────────────────────────

function TurnDetail({ turn }: { turn: TimelineTurn }) {
  const primaryTool = turn.toolCalls[0]

  return (
    <div className="tl-detail">
      <div className="tl-detail-header">
        <span className="tl-detail-badge" style={{ background: ACTION_COLORS[turn.actionType] }}>
          {ACTION_LABELS[turn.actionType]}
        </span>
        <span className="tl-detail-turn">Turn #{turn.index + 1}</span>
        <span className="tl-detail-time">{formatTime(turn.timestamp)}</span>
        <span className="tl-detail-cost">{formatCost(turn.costUsd)}</span>
      </div>

      {/* Tool calls */}
      {turn.toolCalls.length > 0 && (
        <div className="tl-detail-section">
          {turn.toolCalls.map((tc, i) => (
            <div key={i} className={`tl-detail-tool${tc.isError ? ' is-error' : ''}`}>
              <div className="tl-detail-tool-name">{tc.name}</div>
              {tc.inputSummary && (
                <div className="tl-detail-tool-input">{tc.inputSummary}</div>
              )}
              {tc.resultSummary && (
                <div className="tl-detail-tool-result">
                  {tc.isError ? '✗ ' : '→ '}{tc.resultSummary}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Thinking summary */}
      {turn.thinkingSummary && (
        <div className="tl-detail-section">
          <div className="tl-detail-section-label">Thinking</div>
          <div className="tl-detail-thinking">{turn.thinkingSummary}</div>
        </div>
      )}

      {/* Text response */}
      {turn.textSummary && (
        <div className="tl-detail-section">
          <div className="tl-detail-section-label">Response</div>
          <div className="tl-detail-text">{turn.textSummary}</div>
        </div>
      )}

      {/* Token metadata */}
      <div className="tl-detail-meta">
        <span>{formatTokens(turn.inputTokens)} in</span>
        <span>{formatTokens(turn.outputTokens)} out</span>
        {turn.cacheReadTokens > 0 && <span>{formatTokens(turn.cacheReadTokens)} cached</span>}
        {turn.durationMs !== null && <span>{formatDuration(turn.durationMs)}</span>}
        <span className="tl-detail-model">{turn.model}</span>
      </div>
    </div>
  )
}
```

**Step 2: Add CSS styles**

At the end of `src/renderer/styles.css`:

```css
/* ── Timeline View ─────────────────────────────────────────────────────────── */

.tl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 80px 0;
  text-align: center;
}

.tl-empty-icon { color: var(--text-tertiary); margin-bottom: 8px; }
.tl-empty-text { font-size: 14px; color: var(--text-secondary); }
.tl-empty-hint { font-size: 12px; color: var(--text-tertiary); max-width: 320px; line-height: 1.5; }

/* ── Conversation list ──────────────────────────────────────────────────── */

.tl-conversation-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.tl-conversation-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  background: var(--bg-card);
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background 120ms ease;
  font-family: inherit;
  color: inherit;
}

.tl-conversation-item:hover { background: var(--bg-card-hover); }

.tl-conv-top, .tl-conv-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tl-conv-project {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.tl-conv-date {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.tl-conv-id {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.tl-conv-size {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

/* ── Summary stats ──────────────────────────────────────────────────────── */

.tl-summary {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
  padding: 12px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
}

.tl-summary-item { display: flex; align-items: baseline; gap: 6px; }

.tl-summary-value {
  font-size: 16px;
  font-family: var(--font-pixel-square);
  color: var(--text-primary);
}

.tl-summary-label {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ── Legend ──────────────────────────────────────────────────────────────── */

.tl-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 16px;
}

.tl-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
}

.tl-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

/* ── Timeline strip ─────────────────────────────────────────────────────── */

.tl-strip-container {
  margin-bottom: 20px;
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
}

.tl-strip {
  display: flex;
  align-items: center;
  gap: 3px;
  overflow-x: auto;
  padding-bottom: 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.1) transparent;
}

.tl-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 2px;
  background: none;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: transform 100ms ease;
}

.tl-node:hover { transform: scaleY(1.3); }
.tl-node.is-selected { transform: scaleY(1.5); }

.tl-node-dot {
  width: 6px;
  height: 16px;
  border-radius: 3px;
  background: var(--node-color);
  opacity: 0.7;
  transition: opacity 100ms ease;
}

.tl-node:hover .tl-node-dot,
.tl-node.is-selected .tl-node-dot {
  opacity: 1;
}

.tl-node.is-selected .tl-node-dot {
  box-shadow: 0 0 6px var(--node-color);
}

.tl-node-cost {
  font-size: 8px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.tl-time-markers {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 9px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

/* ── Detail panel ───────────────────────────────────────────────────────── */

.tl-detail-empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.tl-detail {
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
  overflow: hidden;
}

.tl-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.tl-detail-badge {
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: 3px;
  color: var(--bg-app);
}

.tl-detail-turn {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
}

.tl-detail-time {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  margin-left: auto;
}

.tl-detail-cost {
  font-size: 13px;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text-primary);
}

.tl-detail-section {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.tl-detail-section:last-child { border-bottom: none; }

.tl-detail-section-label {
  font-size: 10px;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}

.tl-detail-tool {
  margin-bottom: 8px;
}

.tl-detail-tool:last-child { margin-bottom: 0; }

.tl-detail-tool-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.tl-detail-tool-input {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  word-break: break-all;
}

.tl-detail-tool-result {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  margin-top: 4px;
  white-space: pre-wrap;
  max-height: 120px;
  overflow-y: auto;
}

.tl-detail-tool.is-error .tl-detail-tool-result {
  color: var(--error);
}

.tl-detail-thinking,
.tl-detail-text {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
  max-height: 160px;
  overflow-y: auto;
}

.tl-detail-thinking {
  font-style: italic;
  opacity: 0.8;
}

.tl-detail-meta {
  display: flex;
  gap: 12px;
  padding: 10px 16px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  border-top: 1px solid var(--border-subtle);
}

.tl-detail-model {
  margin-left: auto;
  color: var(--text-tertiary);
}
```

**Step 3: Commit**

```bash
git add src/renderer/components/TimelineView.tsx src/renderer/styles.css
git commit -m "feat(timeline): add TimelineView component with conversation browser, timeline strip, and detail panel"
```

---

## Task 8: Smoke Test

**Step 1: Run the type checker**

Run: `cd /Users/cbryant/code/latch-core && npx tsc --noEmit 2>&1 | head -40`
Expected: No new errors from our files

**Step 2: Launch the app in dev mode**

Run: `cd /Users/cbryant/code/latch-core && npm run dev`

**Step 3: Manual verification checklist**

- [ ] Sidebar shows "Timeline" under OBSERVE (between Usage and Radar)
- [ ] Clicking Timeline shows the conversation list
- [ ] Conversations are listed with project name, date, size
- [ ] Clicking a conversation loads and shows the timeline strip
- [ ] Timeline nodes are color-coded by action type (blue/green/yellow/red/gray)
- [ ] Legend shows action type counts
- [ ] Summary shows turn count, total cost, duration, model
- [ ] Clicking a node shows the detail panel
- [ ] Detail panel shows tool name, input summary, result summary, thinking
- [ ] Token/cost metadata appears at the bottom of detail panel
- [ ] Back button returns to conversation list
- [ ] Expensive turns (>$0.10) show cost annotations on nodes
