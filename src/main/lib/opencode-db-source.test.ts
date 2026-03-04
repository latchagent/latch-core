import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeDbSource } from './opencode-db-source'

/**
 * Create a temp SQLite DB with the OpenCode schema and seed it with test data.
 */
function createTestDb(dbPath: string) {
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)

  // Seed: one session with user prompt + assistant response with tool call
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
    'ses-1', 'Fix the bug', '/project/foo', 1709467200000, 1709467300000
  )

  // User message
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'msg-u1', 'ses-1', 1709467200000, 1709467200000,
    JSON.stringify({ role: 'user' })
  )
  // User text part
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt-u1', 'msg-u1', 'ses-1', 1709467200000, 1709467200000,
    JSON.stringify({ type: 'text', text: 'Fix the bug in main.ts' })
  )

  // Assistant message
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'msg-a1', 'ses-1', 1709467205000, 1709467210000,
    JSON.stringify({
      role: 'assistant',
      modelID: 'claude-sonnet-4-6',
      providerID: 'anthropic',
      cost: 0.05,
      tokens: { input: 2000, output: 800, reasoning: 100, cache: { read: 500, write: 200 } },
      time: { created: 1709467205000, completed: 1709467210000 },
      finish: 'tool-calls',
    })
  )
  // Reasoning part
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt-r1', 'msg-a1', 'ses-1', 1709467205100, 1709467205100,
    JSON.stringify({ type: 'reasoning', text: 'Let me read the file first.' })
  )
  // Tool call part (read)
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt-t1', 'msg-a1', 'ses-1', 1709467206000, 1709467207000,
    JSON.stringify({
      type: 'tool',
      tool: 'read',
      callID: 'call-1',
      state: {
        status: 'completed',
        input: { filePath: '/project/foo/main.ts' },
        output: 'const x = 1;',
        time: { start: 1709467206, end: 1709467207 },
      },
    })
  )
  // Tool call part (edit)
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt-t2', 'msg-a1', 'ses-1', 1709467207000, 1709467208000,
    JSON.stringify({
      type: 'tool',
      tool: 'edit',
      callID: 'call-2',
      state: {
        status: 'completed',
        input: { filePath: '/project/foo/main.ts' },
        output: 'Edit applied.',
        time: { start: 1709467207, end: 1709467208 },
      },
    })
  )
  // Step finish
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt-sf1', 'msg-a1', 'ses-1', 1709467209000, 1709467209000,
    JSON.stringify({
      type: 'step-finish',
      reason: 'tool-calls',
      cost: 0.05,
      tokens: { input: 2000, output: 800, reasoning: 100, cache: { read: 500, write: 200 } },
    })
  )
  // Text response
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt-txt1', 'msg-a1', 'ses-1', 1709467209500, 1709467209500,
    JSON.stringify({ type: 'text', text: 'Fixed the bug.' })
  )

  db.close()
}

describe('OpenCodeDbSource', () => {
  let dbPath: string
  let source: OpenCodeDbSource

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `opencode-test-${Date.now()}.db`)
    createTestDb(dbPath)
    source = new OpenCodeDbSource(dbPath)
  })

  afterEach(() => {
    try { fs.unlinkSync(dbPath) } catch { /* ok */ }
  })

  it('has id = opencode-db', () => {
    expect(source.id).toBe('opencode-db')
  })

  it('lists conversations from the OpenCode DB', () => {
    const convs = source.listConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0].id).toBe('ses-1')
    expect(convs[0].projectName).toBe('Fix the bug')
    expect(convs[0].sourceId).toBe('opencode-db')
    expect(convs[0].harnessId).toBe('opencode')
  })

  it('returns empty array when DB does not exist', () => {
    const missing = new OpenCodeDbSource('/tmp/nonexistent-opencode.db')
    expect(missing.listConversations()).toEqual([])
  })

  it('loads a conversation with turns', () => {
    const data = source.loadConversation('ses-1')
    expect(data).not.toBeNull()
    expect(data!.turns).toHaveLength(2)

    // Turn 0: user prompt
    expect(data!.turns[0].actionType).toBe('prompt')
    expect(data!.turns[0].textSummary).toContain('Fix the bug')

    // Turn 1: assistant with tool calls
    expect(data!.turns[1].toolCalls).toHaveLength(2)
    expect(data!.turns[1].toolCalls[0].name).toBe('read')
    expect(data!.turns[1].toolCalls[0].inputSummary).toBe('/project/foo/main.ts')
    expect(data!.turns[1].toolCalls[1].name).toBe('edit')
    expect(data!.turns[1].model).toBe('claude-sonnet-4-6')
  })

  it('extracts cost and tokens from step-finish', () => {
    const data = source.loadConversation('ses-1')!
    expect(data.totalCostUsd).toBeCloseTo(0.05)
    expect(data.turns[1].costUsd).toBeCloseTo(0.05)
    expect(data.turns[1].inputTokens).toBe(2000)
    expect(data.turns[1].outputTokens).toBe(800)
  })

  it('extracts thinking summary from reasoning parts', () => {
    const data = source.loadConversation('ses-1')!
    expect(data.turns[1].thinkingSummary).toContain('read the file first')
  })

  it('returns null for nonexistent session', () => {
    expect(source.loadConversation('ses-nonexistent')).toBeNull()
  })

  it('classifies action types correctly', () => {
    const data = source.loadConversation('ses-1')!
    // read tool → 'read' action type (via normalizeToolName → 'Read')
    expect(data.turns[1].actionType).toBe('read')
  })

  it('calculates duration from message timing', () => {
    const data = source.loadConversation('ses-1')!
    // Assistant message: created=1709467205000, completed=1709467210000 → 5000ms
    expect(data.turns[1].durationMs).toBe(5000)
  })

  it('handles error tool states', () => {
    // Add an error tool call
    const db = new Database(dbPath)
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      'msg-a2', 'ses-1', 1709467215000, 1709467220000,
      JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-4-6', time: { created: 1709467215000, completed: 1709467220000 } })
    )
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
      'prt-err', 'msg-a2', 'ses-1', 1709467216000, 1709467216000,
      JSON.stringify({
        type: 'tool', tool: 'bash', callID: 'call-err',
        state: { status: 'error', input: { command: 'rm -rf /' }, error: 'Permission denied' },
      })
    )
    db.close()

    const data = source.loadConversation('ses-1')!
    const errorTurn = data.turns[2]
    expect(errorTurn.toolCalls[0].isError).toBe(true)
    expect(errorTurn.toolCalls[0].resultSummary).toBe('Permission denied')
    expect(errorTurn.actionType).toBe('error')
  })
})
