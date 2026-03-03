# Merge Timeline + Replay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge the Timeline and Replay views into a single unified Replay view that shows Timeline's summary stats and action legend above Replay's playback experience.

**Architecture:** The existing ReplayView gets two new sub-components (SummaryBar, ActionLegend) inserted between the header and scrub bar. The store gains one `replaySummary` field populated from existing `loadTimeline` data. TimelineView, its nav entry, route, dedicated store state, and CSS are removed.

**Tech Stack:** React 18, Zustand, TypeScript, Phosphor Icons, CSS custom properties

---

### Task 1: Add `replaySummary` to the store and populate it from `loadReplay`

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Add state field and type**

In the state interface (around line 217, after `replayCheckpointIndices`), add:

```typescript
  replaySummary: { totalCostUsd: number; totalDurationMs: number; turnCount: number; models: string[] } | null;
```

In the initial state (around line 472, after `replayCheckpointIndices`), add:

```typescript
  replaySummary:            null,
```

**Step 2: Populate `replaySummary` in `loadReplay`**

In `loadReplay` (line 1839), update the `set()` call at line 1861 to include summary data:

```typescript
    set({
      replayConversationId: data.conversation.id,
      replayTurns: data.turns,
      replayCurrentIndex: 0,
      replayIsPlaying: false,
      replayCheckpointIndices: checkpointIndices,
      replaySummary: {
        totalCostUsd: data.totalCostUsd,
        totalDurationMs: data.totalDurationMs,
        turnCount: data.turnCount,
        models: data.models,
      },
    })
```

Also clear it when resetting replay. In the `if (!filePath)` branch at line 1841:

```typescript
      set({ replayConversationId: null, replayTurns: [], replayCurrentIndex: 0, replayCheckpointIndices: [], replaySummary: null })
```

And in `setReplayConversation` (line 1828), add `replaySummary: null` to the set call.

**Step 3: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "feat(replay): add replaySummary state for merged timeline+replay"
```

---

### Task 2: Add SummaryBar and ActionLegend to ReplayView

**Files:**
- Modify: `src/renderer/components/ReplayView.tsx`

**Step 1: Add `replaySummary` to the store destructure**

At line 85, add `replaySummary` to the destructured store values:

```typescript
    replaySummary,
```

**Step 2: Add SummaryBar sub-component**

Add this after the existing `formatTokens` helper (around line 34), before `ACTION_COLORS`:

```typescript
function SummaryBar({ summary }: { summary: { totalCostUsd: number; totalDurationMs: number; turnCount: number; models: string[] } }) {
  return (
    <div className="replay-summary-bar">
      <span className="replay-summary-item">
        <span className="replay-summary-value">{summary.turnCount}</span>
        <span className="replay-summary-label">turns</span>
      </span>
      <span className="replay-summary-item">
        <span className="replay-summary-value">{formatCost(summary.totalCostUsd)}</span>
        <span className="replay-summary-label">cost</span>
      </span>
      <span className="replay-summary-item">
        <span className="replay-summary-value">{formatDuration(summary.totalDurationMs)}</span>
        <span className="replay-summary-label">duration</span>
      </span>
      <span className="replay-summary-item">
        <span className="replay-summary-value">{summary.models.join(', ')}</span>
        <span className="replay-summary-label">model</span>
      </span>
    </div>
  )
}
```

**Step 3: Add ActionLegend sub-component**

Add right after SummaryBar:

```typescript
function ActionLegend({ turns }: { turns: TimelineTurn[] }) {
  const counts: Partial<Record<TimelineActionType, number>> = {}
  for (const turn of turns) {
    counts[turn.actionType] = (counts[turn.actionType] ?? 0) + 1
  }
  const entries = Object.entries(counts) as [TimelineActionType, number][]
  if (entries.length === 0) return null

  return (
    <div className="replay-action-legend">
      {entries.map(([type, count]) => (
        <span key={type} className="replay-legend-item">
          <span className="replay-legend-dot" style={{ background: ACTION_COLORS[type] }} />
          {ACTION_LABELS[type]} {count}
        </span>
      ))}
    </div>
  )
}
```

**Step 4: Insert SummaryBar and ActionLegend into the player view**

In the player return (line 169), insert them between the `view-header` div and the `replay-stats-bar` div. Find:

```tsx
        {/* Stats bar */}
        <div className="replay-stats-bar">
```

Insert before it:

```tsx
        {/* Summary + legend (from Timeline) */}
        {replaySummary && <SummaryBar summary={replaySummary} />}
        <ActionLegend turns={replayTurns} />
```

**Step 5: Commit**

```bash
git add src/renderer/components/ReplayView.tsx
git commit -m "feat(replay): add SummaryBar and ActionLegend to player view"
```

---

### Task 3: Add CSS for SummaryBar and ActionLegend

**Files:**
- Modify: `src/renderer/styles.css`

**Step 1: Add styles**

Find the existing Replay CSS section (search for `replay-stats-bar`). Add these styles before it:

```css
/* ── Replay Summary + Legend (from Timeline merge) ─────────────────────────── */

.replay-summary-bar {
  display: flex;
  align-items: baseline;
  gap: 24px;
  padding: 10px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  margin-bottom: 8px;
}

.replay-summary-item {
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.replay-summary-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.replay-summary-label {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.replay-action-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 6px 0;
  margin-bottom: 4px;
}

.replay-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary);
}

.replay-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
```

**Step 2: Commit**

```bash
git add src/renderer/styles.css
git commit -m "style(replay): add summary bar and action legend styles"
```

---

### Task 4: Remove Timeline from the sidebar, App router, and AppView type

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/types/index.ts`

**Step 1: Remove Timeline nav item from Sidebar**

In `src/renderer/components/Sidebar.tsx`, remove the Timeline button block (lines 128-134):

```tsx
        <button
          className={`sidebar-nav-item${activeView === 'timeline' ? ' is-active' : ''}`}
          onClick={() => setActiveView('timeline')}
        >
          <GitBranch className="sidebar-nav-icon" weight="light" />
          Timeline
        </button>
```

Also remove `GitBranch` from the Phosphor imports at line 2 (remove just that one identifier from the import list).

**Step 2: Remove TimelineView from App.tsx**

In `src/renderer/App.tsx`, remove the import at line 28:

```typescript
import TimelineView     from './components/TimelineView'
```

And remove the route block (lines 262-263):

```typescript
  } else if (activeView === 'timeline') {
    mainContent = <TimelineView />
```

**Step 3: Remove `'timeline'` from AppView type**

In `src/types/index.ts`, line 920, remove `'timeline'` from the union:

```typescript
// Before:
export type AppView = 'home' | 'sessions' | 'policies' | ... | 'timeline' | 'analytics' | ...

// After:
export type AppView = 'home' | 'sessions' | 'policies' | ... | 'analytics' | ...
```

**Step 4: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/App.tsx src/types/index.ts
git commit -m "refactor: remove Timeline nav item, route, and AppView entry"
```

---

### Task 5: Remove Timeline-specific store state and actions

**Files:**
- Modify: `src/renderer/store/useAppStore.ts`

**Step 1: Remove state fields from interface**

Remove these three lines from the state interface (lines 185-187):

```typescript
  timelineData: TimelineData | null;
  timelineSelectedTurn: number | null;
  timelineLoading: boolean;
```

Keep `timelineConversations: TimelineConversation[];` (line 184) — it's still used by Replay.

**Step 2: Remove action declarations from interface**

Remove these two lines from the actions section (lines 356-357):

```typescript
  loadTimeline:              (filePath: string) => Promise<void>;
  setTimelineSelectedTurn:   (index: number | null) => void;
```

Keep `loadTimelineConversations` (line 355) — still used by Replay.

**Step 3: Remove initial state values**

Remove these three lines from the initial state (lines 450-452):

```typescript
  timelineData:          null,
  timelineSelectedTurn:  null,
  timelineLoading:       false,
```

Keep `timelineConversations: [],` (line 449).

**Step 4: Remove action implementations**

Remove the `loadTimeline` and `setTimelineSelectedTurn` implementations (lines 1608-1621):

```typescript
  loadTimeline: async (filePath: string) => {
    set({ timelineLoading: true, timelineSelectedTurn: null })
    const result = await window.latch?.loadTimeline?.({ filePath })
    const data = result?.data ?? null
    set({
      timelineData: data,
      timelineLoading: false,
      timelineSelectedTurn: data && data.turns.length > 0 ? 0 : null,
    })
  },

  setTimelineSelectedTurn: (index: number | null) => {
    set({ timelineSelectedTurn: index })
  },
```

Keep `loadTimelineConversations` (lines 1601-1606).

**Step 5: Remove `TimelineData` from imports**

At line 35, remove `TimelineData` from the type import. Keep `TimelineConversation` (line 34).

**Step 6: Commit**

```bash
git add src/renderer/store/useAppStore.ts
git commit -m "refactor: remove timeline-specific store state and actions"
```

---

### Task 6: Remove Timeline CSS

**Files:**
- Modify: `src/renderer/styles.css`

**Step 1: Delete the Timeline View CSS block**

Remove the entire block from line 5663 through line 6005:

```css
/* ── Timeline View ─────────────────────────────────── */

.tl-empty { ... }
...
.tl-detail-model { ... }
```

This is everything between the `/* ── Timeline View */` comment and the `/* ── Analytics Tooltips */` comment.

**Step 2: Commit**

```bash
git add src/renderer/styles.css
git commit -m "style: remove timeline-specific CSS classes"
```

---

### Task 7: Delete TimelineView.tsx

**Files:**
- Delete: `src/renderer/components/TimelineView.tsx`

**Step 1: Delete the file**

```bash
rm src/renderer/components/TimelineView.tsx
```

**Step 2: Verify no remaining references**

```bash
grep -r "TimelineView\|'timeline'" src/renderer/ src/types/ --include="*.ts" --include="*.tsx"
```

Expected: no matches (or only `timelineConversations` / `loadTimelineConversations` which are kept).

**Step 3: Type check**

```bash
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -i "timeline"
```

Expected: no timeline-related errors.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete TimelineView.tsx — merged into Replay"
```

---

### Task 8: Verify the merged view works end-to-end

**Step 1: Run the app**

```bash
npm run dev
```

**Step 2: Manual test checklist**

- [ ] Sidebar shows "Replay" but NOT "Timeline"
- [ ] Clicking "Replay" shows conversation picker
- [ ] Selecting a conversation shows: summary bar, action legend, scrub bar, activity stream + detail, playback controls
- [ ] Summary bar shows turn count, cost, duration, model
- [ ] Action legend shows color-coded counts for each action type
- [ ] Play/pause/step/seek all work
- [ ] Keyboard shortcuts (Space, arrow keys) work
- [ ] Speed selector works
- [ ] Back button returns to conversation picker
