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
  prompt:  'rgb(var(--d-cyan, 34 211 238))',
}
