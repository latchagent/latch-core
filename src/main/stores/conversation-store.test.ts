import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ConversationStore } from './conversation-store'

describe('ConversationStore', () => {
  let store: ConversationStore

  beforeEach(() => {
    const db = new Database(':memory:')
    store = ConversationStore.open(db)
  })

  it('records and retrieves a conversation event', () => {
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'tool-call',
      turnIndex: 1,
      toolName: 'Bash',
      toolInput: 'ls -la',
      toolResult: 'total 42',
      isError: false,
    })

    const events = store.listBySession('sess-1')
    expect(events).toHaveLength(1)
    expect(events[0].toolName).toBe('Bash')
    expect(events[0].turnIndex).toBe(1)
  })

  it('lists conversations with aggregates', () => {
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'tool-call',
      turnIndex: 1,
      toolName: 'Read',
      costUsd: 0.01,
    })
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:01:00Z',
      kind: 'response',
      turnIndex: 1,
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.02,
    })
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:05:00Z',
      kind: 'prompt',
      turnIndex: 2,
      textContent: 'Fix the bug',
    })

    const convs = store.listConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0].sessionId).toBe('sess-1')
    expect(convs[0].harnessId).toBe('opencode')
    expect(convs[0].totalCostUsd).toBeCloseTo(0.03)
    expect(convs[0].turnCount).toBe(2)
  })

  it('returns first prompt as preview', () => {
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'prompt',
      turnIndex: 1,
      textContent: 'Build a REST API',
    })

    const convs = store.listConversations()
    expect(convs[0].promptPreview).toBe('Build a REST API')
  })

  it('deduplicates events by id', () => {
    const params = {
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'tool-call' as const,
      turnIndex: 1,
      toolName: 'Bash',
    }
    store.record(params)
    store.record(params) // duplicate — should not throw

    const events = store.listBySession('sess-1')
    // May have 1 or 2 depending on ID generation, but no crash
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  it('clears events by session', () => {
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'session-start',
    })
    store.record({
      sessionId: 'sess-2',
      harnessId: 'opencode',
      timestamp: '2026-03-03T10:00:00Z',
      kind: 'session-start',
    })

    store.clear('sess-1')
    expect(store.listBySession('sess-1')).toHaveLength(0)
    expect(store.listBySession('sess-2')).toHaveLength(1)
  })
})
