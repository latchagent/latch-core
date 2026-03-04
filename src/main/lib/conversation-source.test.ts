/**
 * @module conversation-source.test
 * @description Tests for ConversationSource interface, ConversationRegistry,
 * ClaudeConversationSource, and PluginConversationSource turn assembly.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { ConversationStore } from '../stores/conversation-store'
import {
  ConversationRegistry,
  ClaudeConversationSource,
  PluginConversationSource,
} from './conversation-source'
import type { ConversationSource } from './conversation-source'
import type { TimelineConversation, TimelineData, TimelineTurn } from '../../types'

// ── Stub source for registry tests ──────────────────────────────────────────

function makeStubSource(id: string, conversations: TimelineConversation[]): ConversationSource {
  const dataMap = new Map<string, TimelineData>()
  for (const c of conversations) {
    dataMap.set(c.id, {
      conversation: c,
      turns: [],
      totalCostUsd: c.totalCostUsd,
      totalDurationMs: 0,
      turnCount: c.turnCount,
      models: [],
    })
  }
  return {
    id,
    listConversations: (_projectSlug?: string) => conversations,
    loadConversation: (conversationId: string) => dataMap.get(conversationId) ?? null,
  }
}

function makeConversation(overrides: Partial<TimelineConversation> & { id: string }): TimelineConversation {
  return {
    filePath: `/fake/${overrides.id}.jsonl`,
    projectSlug: 'test-project',
    projectName: 'Test Project',
    lastModified: '2025-01-01T00:00:00.000Z',
    sizeBytes: 1024,
    promptPreview: null,
    totalCostUsd: 0,
    totalTokens: 0,
    turnCount: 0,
    sourceId: 'stub',
    ...overrides,
  }
}

// ── Registry tests ──────────────────────────────────────────────────────────

describe('ConversationRegistry', () => {
  it('merges conversations from multiple sources, sorted by lastModified desc', () => {
    const sourceA = makeStubSource('source-a', [
      makeConversation({ id: 'a1', lastModified: '2025-01-01T00:00:00.000Z', sourceId: 'source-a' }),
      makeConversation({ id: 'a2', lastModified: '2025-01-03T00:00:00.000Z', sourceId: 'source-a' }),
    ])
    const sourceB = makeStubSource('source-b', [
      makeConversation({ id: 'b1', lastModified: '2025-01-02T00:00:00.000Z', sourceId: 'source-b' }),
      makeConversation({ id: 'b2', lastModified: '2025-01-04T00:00:00.000Z', sourceId: 'source-b' }),
    ])

    const registry = new ConversationRegistry()
    registry.register(sourceA)
    registry.register(sourceB)

    const all = registry.listAll()
    expect(all).toHaveLength(4)
    expect(all[0].id).toBe('b2') // Jan 4 - newest
    expect(all[1].id).toBe('a2') // Jan 3
    expect(all[2].id).toBe('b1') // Jan 2
    expect(all[3].id).toBe('a1') // Jan 1 - oldest
  })

  it('routes load() to the correct source by sourceId', () => {
    const sourceA = makeStubSource('source-a', [
      makeConversation({ id: 'a1', sourceId: 'source-a', totalCostUsd: 1.23 }),
    ])
    const sourceB = makeStubSource('source-b', [
      makeConversation({ id: 'b1', sourceId: 'source-b', totalCostUsd: 4.56 }),
    ])

    const registry = new ConversationRegistry()
    registry.register(sourceA)
    registry.register(sourceB)

    const resultA = registry.load('a1', 'source-a')
    expect(resultA).not.toBeNull()
    expect(resultA!.conversation.id).toBe('a1')
    expect(resultA!.totalCostUsd).toBe(1.23)

    const resultB = registry.load('b1', 'source-b')
    expect(resultB).not.toBeNull()
    expect(resultB!.conversation.id).toBe('b1')
    expect(resultB!.totalCostUsd).toBe(4.56)
  })

  it('returns null for unknown sourceId', () => {
    const registry = new ConversationRegistry()
    const result = registry.load('any-id', 'nonexistent-source')
    expect(result).toBeNull()
  })
})

// ── ClaudeConversationSource test ───────────────────────────────────────────

describe('ClaudeConversationSource', () => {
  it('has id = "claude-jsonl"', () => {
    const source = new ClaudeConversationSource()
    expect(source.id).toBe('claude-jsonl')
  })
})

// ── PluginConversationSource tests ──────────────────────────────────────────

describe('PluginConversationSource', () => {
  function createInMemoryStore(): ConversationStore {
    const db = new Database(':memory:')
    return ConversationStore.open(db)
  }

  it('has id = "opencode-sse"', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)
    expect(source.id).toBe('opencode-sse')
  })

  it('assembles tool calls into turns grouped by turn_index', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)

    const sessionId = 'test-session'
    const baseTs = '2025-06-01T10:00:00.000Z'

    // Turn 0: a prompt
    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: baseTs,
      kind: 'prompt',
      turnIndex: 0,
      textContent: 'Fix the login bug',
    })

    // Turn 1: two tool calls + step-finish
    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:05.000Z',
      kind: 'tool-call',
      turnIndex: 1,
      toolName: 'Read',
      toolInput: 'src/auth.ts',
      toolResult: 'file contents here',
      isError: false,
    })
    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:06.000Z',
      kind: 'tool-call',
      turnIndex: 1,
      toolName: 'Edit',
      toolInput: 'src/auth.ts',
      toolResult: 'edit applied',
      isError: false,
    })
    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:07.000Z',
      kind: 'step-finish',
      turnIndex: 1,
      model: 'claude-sonnet-4',
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.003,
    })

    const events = store.listBySession(sessionId)
    const turns = source.assembleTimeline(events)

    expect(turns).toHaveLength(2)

    // Turn 0: prompt
    expect(turns[0].actionType).toBe('prompt')
    expect(turns[0].textSummary).toBe('Fix the login bug')
    expect(turns[0].toolCalls).toHaveLength(0)

    // Turn 1: tool calls
    expect(turns[1].toolCalls).toHaveLength(2)
    expect(turns[1].toolCalls[0].name).toBe('Read')
    expect(turns[1].toolCalls[1].name).toBe('Edit')
    expect(turns[1].model).toBe('claude-sonnet-4')
    expect(turns[1].inputTokens).toBe(500)
    expect(turns[1].outputTokens).toBe(200)
  })

  it('sums step-finish tokens and cost across multiple step events', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)

    const sessionId = 'sum-session'

    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:00.000Z',
      kind: 'step-finish',
      turnIndex: 0,
      model: 'claude-sonnet-4',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.001,
    })
    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:01.000Z',
      kind: 'step-finish',
      turnIndex: 0,
      model: 'claude-sonnet-4',
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      costUsd: 0.002,
    })

    const events = store.listBySession(sessionId)
    const turns = source.assembleTimeline(events)

    expect(turns).toHaveLength(1)
    expect(turns[0].inputTokens).toBe(300)
    expect(turns[0].outputTokens).toBe(150)
    expect(turns[0].cacheReadTokens).toBe(30)
    expect(turns[0].cacheWriteTokens).toBe(15)
    expect(turns[0].costUsd).toBeCloseTo(0.003)
  })

  it('returns null for empty session', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)
    const result = source.loadConversation('nonexistent-session')
    expect(result).toBeNull()
  })

  it('calculates total cost and duration', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)
    const sessionId = 'cost-session'

    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:00.000Z',
      kind: 'prompt',
      turnIndex: 0,
      textContent: 'Hello',
    })
    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:10.000Z',
      kind: 'step-finish',
      turnIndex: 1,
      model: 'claude-sonnet-4',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
    })
    store.record({
      sessionId,
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:20.000Z',
      kind: 'step-finish',
      turnIndex: 2,
      model: 'claude-sonnet-4',
      inputTokens: 2000,
      outputTokens: 800,
      costUsd: 0.02,
    })

    const result = source.loadConversation(sessionId)
    expect(result).not.toBeNull()
    expect(result!.totalCostUsd).toBeCloseTo(0.03)
    // Duration = last timestamp - first timestamp = 20 seconds
    expect(result!.totalDurationMs).toBe(20_000)
    expect(result!.turnCount).toBe(3)
    expect(result!.models).toContain('claude-sonnet-4')
  })

  it('lists conversations from the store', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)

    // Record events for two sessions
    store.record({
      sessionId: 'sess-1',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:00.000Z',
      kind: 'prompt',
      turnIndex: 0,
      textContent: 'First prompt',
    })
    store.record({
      sessionId: 'sess-2',
      harnessId: 'opencode',
      timestamp: '2025-06-01T11:00:00.000Z',
      kind: 'prompt',
      turnIndex: 0,
      textContent: 'Second prompt',
    })

    source.setSessionMeta('sess-1', {
      projectSlug: 'my-project',
      projectName: 'My Project',
      projectDir: '/code/my-project',
    })

    const conversations = source.listConversations()
    expect(conversations).toHaveLength(2)

    // Should be sorted by lastModified desc
    expect(conversations[0].id).toBe('sess-2')
    expect(conversations[1].id).toBe('sess-1')

    // The one with meta should have project info
    expect(conversations[1].projectSlug).toBe('my-project')
    expect(conversations[1].projectName).toBe('My Project')
    expect(conversations[1].sourceId).toBe('opencode-sse')
    expect(conversations[1].harnessId).toBe('opencode')
  })

  it('filters listConversations by projectSlug', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)

    store.record({
      sessionId: 'sess-a',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:00.000Z',
      kind: 'prompt',
      turnIndex: 0,
      textContent: 'Hello A',
    })
    store.record({
      sessionId: 'sess-b',
      harnessId: 'opencode',
      timestamp: '2025-06-01T11:00:00.000Z',
      kind: 'prompt',
      turnIndex: 0,
      textContent: 'Hello B',
    })

    source.setSessionMeta('sess-a', {
      projectSlug: 'project-alpha',
      projectName: 'Alpha',
      projectDir: '/code/alpha',
    })
    source.setSessionMeta('sess-b', {
      projectSlug: 'project-beta',
      projectName: 'Beta',
      projectDir: '/code/beta',
    })

    const alpha = source.listConversations('project-alpha')
    expect(alpha).toHaveLength(1)
    expect(alpha[0].id).toBe('sess-a')

    const beta = source.listConversations('project-beta')
    expect(beta).toHaveLength(1)
    expect(beta[0].id).toBe('sess-b')
  })

  it('uses thinking events as thinkingSummary', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)

    store.record({
      sessionId: 'think-session',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:00.000Z',
      kind: 'thinking',
      turnIndex: 0,
      textContent: 'Let me analyze the code...',
    })
    store.record({
      sessionId: 'think-session',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:01.000Z',
      kind: 'step-finish',
      turnIndex: 0,
      model: 'claude-sonnet-4',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    })

    const events = store.listBySession('think-session')
    const turns = source.assembleTimeline(events)

    expect(turns).toHaveLength(1)
    expect(turns[0].thinkingSummary).toBe('Let me analyze the code...')
  })

  it('classifies action types from tool names', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)

    // Turn with Bash tool call -> 'bash' action type
    store.record({
      sessionId: 'classify-session',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:00.000Z',
      kind: 'tool-call',
      turnIndex: 0,
      toolName: 'Bash',
      toolInput: 'npm test',
    })

    // Turn with Read tool call -> 'read' action type
    store.record({
      sessionId: 'classify-session',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:05.000Z',
      kind: 'tool-call',
      turnIndex: 1,
      toolName: 'Read',
      toolInput: 'src/index.ts',
    })

    // Turn with error -> 'error' action type
    store.record({
      sessionId: 'classify-session',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:10.000Z',
      kind: 'tool-call',
      turnIndex: 2,
      toolName: 'Write',
      toolInput: 'src/broken.ts',
      isError: true,
    })

    const events = store.listBySession('classify-session')
    const turns = source.assembleTimeline(events)

    expect(turns).toHaveLength(3)
    expect(turns[0].actionType).toBe('bash')
    expect(turns[1].actionType).toBe('read')
    expect(turns[2].actionType).toBe('error')
  })

  it('calculates durations from timestamp gaps between turns', () => {
    const store = createInMemoryStore()
    const source = new PluginConversationSource(store)

    store.record({
      sessionId: 'dur-session',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:00.000Z',
      kind: 'prompt',
      turnIndex: 0,
      textContent: 'Start',
    })
    store.record({
      sessionId: 'dur-session',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:05.000Z',
      kind: 'step-finish',
      turnIndex: 1,
      model: 'claude-sonnet-4',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    })
    store.record({
      sessionId: 'dur-session',
      harnessId: 'opencode',
      timestamp: '2025-06-01T10:00:15.000Z',
      kind: 'step-finish',
      turnIndex: 2,
      model: 'claude-sonnet-4',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.002,
    })

    const events = store.listBySession('dur-session')
    const turns = source.assembleTimeline(events)

    expect(turns).toHaveLength(3)
    // Turn 0 -> Turn 1: 5 seconds
    expect(turns[0].durationMs).toBe(5_000)
    // Turn 1 -> Turn 2: 10 seconds
    expect(turns[1].durationMs).toBe(10_000)
    // Last turn: no duration
    expect(turns[2].durationMs).toBeNull()
  })
})
