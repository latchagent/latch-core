import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ConversationStore } from '../stores/conversation-store'
import { processOpenCodeEvent } from './opencode-tailer'
import type { ProcessContext } from './opencode-tailer'
import type { LiveEvent } from '../../types'

describe('processOpenCodeEvent', () => {
  let store: ConversationStore
  let emitted: LiveEvent[]
  let ctx: ProcessContext

  beforeEach(() => {
    const db = new Database(':memory:')
    store = ConversationStore.open(db)
    emitted = []
    ctx = {
      sessionId: 'latch-sess-1',
      store,
      emit: (event: LiveEvent) => emitted.push(event),
      turnIndex: 1,
    }
  })

  it('processes message.updated for assistant with cost/tokens', () => {
    processOpenCodeEvent(
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-1',
            role: 'assistant',
            modelID: 'claude-sonnet-4-6',
            cost: 0.05,
            tokens: { input: 2000, output: 800, reasoning: 100, cache: { read: 500, write: 200 } },
            time: { created: 1709467200 },
          },
        },
      },
      ctx,
    )

    const events = store.listBySession('latch-sess-1')
    const stepFinish = events.find((e) => e.kind === 'step-finish')
    expect(stepFinish).toBeDefined()
    expect(stepFinish!.model).toBe('claude-sonnet-4-6')
    expect(stepFinish!.costUsd).toBe(0.05)
    expect(stepFinish!.inputTokens).toBe(2000)
    expect(stepFinish!.outputTokens).toBe(800)

    // Should emit a tool-call LiveEvent with cost info
    const liveEvt = emitted.find((e) => e.kind === 'tool-call' && e.toolName === 'step-finish')
    expect(liveEvt).toBeDefined()
    expect(liveEvt!.costUsd).toBe(0.05)
    expect(liveEvt!.inputTokens).toBe(2000)
    expect(liveEvt!.outputTokens).toBe(800)
    expect(liveEvt!.target).toBe('claude-sonnet-4-6')
  })

  it('processes message.part.updated for completed tool call', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'ls -la' },
              output: 'total 42\ndrwxr-xr-x ...',
              time: { start: 1709467200, end: 1709467201 },
            },
          },
        },
      },
      ctx,
    )

    const events = store.listBySession('latch-sess-1')
    const toolCall = events.find((e) => e.kind === 'tool-call')
    expect(toolCall).toBeDefined()
    expect(toolCall!.toolName).toBe('bash')
    expect(toolCall!.toolInput).toBe('ls -la')
    expect(toolCall!.toolResult).toContain('total 42')
    expect(toolCall!.isError).toBe(false)

    const liveEvt = emitted.find((e) => e.kind === 'tool-call' && e.toolName === 'bash')
    expect(liveEvt).toBeDefined()
    expect(liveEvt!.toolName).toBe('bash')
    expect(liveEvt!.target).toBe('ls -la')
    expect(liveEvt!.status).toBe('success')
  })

  it('processes reasoning part as thinking event', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            text: 'Let me think about this carefully...',
          },
        },
      },
      ctx,
    )

    const events = store.listBySession('latch-sess-1')
    const thinking = events.find((e) => e.kind === 'thinking')
    expect(thinking).toBeDefined()
    expect(thinking!.textContent).toContain('think about this carefully')

    // Should also emit a LiveEvent for thinking
    const liveEvt = emitted.find((e) => e.kind === 'thinking')
    expect(liveEvt).toBeDefined()
    expect(liveEvt!.thinkingSummary).toContain('think about this carefully')
  })

  it('processes tool error state', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'error',
              input: { command: 'rm -rf /' },
              error: 'Permission denied',
              time: { start: 1709467200, end: 1709467201 },
            },
          },
        },
      },
      ctx,
    )

    const events = store.listBySession('latch-sess-1')
    const toolCall = events.find((e) => e.kind === 'tool-call')
    expect(toolCall!.isError).toBe(true)
    expect(toolCall!.toolResult).toBe('Permission denied')

    const liveEvt = emitted.find((e) => e.kind === 'tool-call')
    expect(liveEvt!.status).toBe('error')
  })

  it('processes session status events', () => {
    processOpenCodeEvent(
      {
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
        },
      },
      ctx,
    )

    const liveEvt = emitted.find((e) => e.kind === 'status-change')
    expect(liveEvt).toBeDefined()
    expect(liveEvt!.sessionStatus).toBe('idle')
  })

  it('maps busy status to active', () => {
    processOpenCodeEvent(
      {
        type: 'session.status',
        properties: {
          status: { type: 'busy' },
        },
      },
      ctx,
    )

    const liveEvt = emitted.find((e) => e.kind === 'status-change')
    expect(liveEvt).toBeDefined()
    expect(liveEvt!.sessionStatus).toBe('active')
  })

  it('maps retry status to rate-limited', () => {
    processOpenCodeEvent(
      {
        type: 'session.status',
        properties: {
          status: { type: 'retry' },
        },
      },
      ctx,
    )

    const liveEvt = emitted.find((e) => e.kind === 'status-change')
    expect(liveEvt).toBeDefined()
    expect(liveEvt!.sessionStatus).toBe('rate-limited')
  })

  it('ignores user messages without error', () => {
    processOpenCodeEvent(
      {
        type: 'message.updated',
        properties: {
          info: {
            role: 'user',
            time: { created: 1709467200 },
          },
        },
      },
      ctx,
    )

    const events = store.listBySession('latch-sess-1')
    expect(events).toHaveLength(0)
  })

  it('skips pending/running tool states', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'echo hi' } },
          },
        },
      },
      ctx,
    )

    expect(store.listBySession('latch-sess-1')).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })

  it('handles text part', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: 'Here is my response.',
          },
        },
      },
      ctx,
    )

    const events = store.listBySession('latch-sess-1')
    const response = events.find((e) => e.kind === 'response')
    expect(response).toBeDefined()
    expect(response!.textContent).toBe('Here is my response.')
  })

  it('ignores events with no type', () => {
    processOpenCodeEvent({}, ctx)
    processOpenCodeEvent({ type: '' }, ctx)
    expect(store.listBySession('latch-sess-1')).toHaveLength(0)
  })

  it('generates unique ids for emitted LiveEvents', () => {
    processOpenCodeEvent(
      {
        type: 'session.status',
        properties: { status: { type: 'idle' } },
      },
      ctx,
    )
    processOpenCodeEvent(
      {
        type: 'session.status',
        properties: { status: { type: 'busy' } },
      },
      ctx,
    )

    expect(emitted).toHaveLength(2)
    expect(emitted[0].id).toBeTruthy()
    expect(emitted[1].id).toBeTruthy()
    expect(emitted[0].id).not.toBe(emitted[1].id)
  })

  it('extracts file_path as target for file tools', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'read',
            state: {
              status: 'completed',
              input: { file_path: '/src/main.ts' },
              output: 'file contents...',
            },
          },
        },
      },
      ctx,
    )

    const events = store.listBySession('latch-sess-1')
    expect(events[0].toolInput).toBe('/src/main.ts')

    const liveEvt = emitted.find((e) => e.toolName === 'read')
    expect(liveEvt!.target).toBe('/src/main.ts')
  })

  it('does not emit LiveEvents for text parts (store-only)', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            text: 'Hello world',
          },
        },
      },
      ctx,
    )

    // Text parts go to the store but not to LiveEvents
    expect(store.listBySession('latch-sess-1')).toHaveLength(1)
    expect(emitted).toHaveLength(0)
  })

  it('handles message.updated with missing info gracefully', () => {
    processOpenCodeEvent(
      {
        type: 'message.updated',
        properties: {},
      },
      ctx,
    )

    expect(store.listBySession('latch-sess-1')).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })

  it('handles tool part with missing state gracefully', () => {
    processOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
          },
        },
      },
      ctx,
    )

    expect(store.listBySession('latch-sess-1')).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })
})
