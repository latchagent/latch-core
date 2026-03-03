# Merge Timeline + Replay into Unified Replay View

**Date:** 2026-03-03
**Status:** Approved

## Problem

Timeline and Replay are two separate views that operate on the same data (Claude Code conversation JSONL logs parsed into `TimelineTurn[]`). Timeline provides an at-a-glance overview (summary stats, action legend, dot strip), while Replay provides a step-through experience (activity stream, detail panel, playback controls, scrub bar). Having both is redundant and confusing — users must choose between them without a clear reason.

## Decision

Merge both into a single **Replay** view. Timeline's summary context goes on top, Replay's interaction model fills the main area. The Timeline nav item, view, and dedicated store state are removed.

## Layout

### Conversation Picker (no conversation loaded)

Unchanged from current Replay. List of conversation cards showing project name, prompt preview, turn count, cost, tokens. Sorted by most recent.

### Player (conversation loaded)

Single view, top to bottom:

```
┌────────────────────────────────────────────────────────┐
│ <- Conversations              Replay                   │  view-header + back button
├────────────────────────────────────────────────────────┤
│  42 turns    $1.24    3m 12s    claude-sonnet-4-5      │  SummaryBar (from Timeline)
├────────────────────────────────────────────────────────┤
│  * Read 12  * Write 8  * Bash 5  * Search 3  * Err 1  │  ActionLegend (from Timeline)
├────────────────────────────────────────────────────────┤
│ [===========----======-------===========-----------]   │  ScrubBar (from Replay)
│  10:02am              10:14am              10:31am     │  time markers
├─────────────────────────┬──────────────────────────────┤
│  Activity stream        │  Turn detail panel           │  main content (from Replay)
│  (scrollable cards)     │  (tool calls, thinking,      │
│                         │   response, metadata)        │
├─────────────────────────┴──────────────────────────────┤
│     |<<   >>|   [>]          0.5x  [1x]  2x  4x       │  playback controls (from Replay)
└────────────────────────────────────────────────────────┘
```

- Summary + legend + scrub bar are fixed header zones (don't scroll)
- Two-panel area fills remaining vertical space and scrolls independently
- Playback controls pinned to bottom

## What Gets Removed

| Item | Action |
|------|--------|
| `TimelineView.tsx` | Delete |
| `'timeline'` in `AppView` type | Remove |
| Timeline sidebar nav item | Remove |
| Timeline route in `App.tsx` | Remove |
| `timelineData` store state | Remove |
| `timelineSelectedTurn` store state | Remove |
| `timelineLoading` store state | Remove |
| `loadTimeline` store action | Remove |
| `setTimelineSelectedTurn` store action | Remove |
| `tl-*` CSS classes | Remove |

## What Stays / Gets Absorbed

| Item | Action |
|------|--------|
| `timelineConversations` state | Keep (shared by both, used by Replay) |
| `loadTimelineConversations` action | Keep |
| All `replay*` state | Keep |
| `ScrubBar` component | Keep |
| `TurnCard` component | Keep |
| `TurnDetail` component | Keep, absorb Timeline's metadata grid |
| Playback controls | Keep |
| Keyboard shortcuts (Space, arrows) | Keep |

## Store Changes

Add one new field to absorb Timeline's summary data:

```typescript
replaySummary: {
  totalCostUsd: number
  totalDurationMs: number
  turnCount: number
  models: string[]
} | null
```

`loadReplay` already calls `window.latch.loadTimeline()` — it just needs to also stash the summary from `TimelineData` into `replaySummary`.

## New Sub-Components (inside ReplayView.tsx)

### SummaryBar
Compact stats row: turn count, total cost, total duration, model(s). Single line.

### ActionLegend
Computed from loaded turns. Color dot + label + count for each action type present. Single line, wraps if needed.

## Files Changed

1. `src/types/index.ts` — remove `'timeline'` from `AppView`
2. `src/renderer/components/Sidebar.tsx` — remove Timeline nav item
3. `src/renderer/App.tsx` — remove TimelineView import and route
4. `src/renderer/store/useAppStore.ts` — remove timeline state/actions, add `replaySummary`, update `loadReplay`
5. `src/renderer/components/ReplayView.tsx` — add SummaryBar, ActionLegend, absorb timeline metadata
6. `src/renderer/styles.css` — remove `tl-*` classes, add summary/legend styles
7. `src/renderer/components/TimelineView.tsx` — delete file
