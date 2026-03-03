/**
 * @module issue-sync
 * @description Event-driven bidirectional sync between Latch sessions and issue providers.
 * Listens for session lifecycle events and pushes status updates, comments,
 * and PR links back to GitHub/Linear. Skips sync for native Latch tasks.
 */

import type { IssueStore } from '../stores/issue-store'
import type { SecretStore } from '../stores/secret-store'
import * as github from './github-issues'
import * as linear from './linear-issues'

interface IssueSyncOptions {
  issueStore: IssueStore
  secretStore: SecretStore
}

let _issueStore: IssueStore | null = null
let _secretStore: SecretStore | null = null

/** Start the issue sync service. */
export function startIssueSync(opts: IssueSyncOptions): void {
  _issueStore = opts.issueStore
  _secretStore = opts.secretStore
}

/** Stop the issue sync service. */
export function stopIssueSync(): void {
  _issueStore = null
  _secretStore = null
}

/** Called when a session starts working on an issue. Mark as in_progress. */
export async function issueSyncOnSessionStart(sessionId: string): Promise<void> {
  if (!_issueStore || !_secretStore) return
  const issue = _issueStore.findBySession(sessionId)
  if (!issue || issue.provider === 'latch') {
    // Native tasks update directly — no external sync needed
    if (issue?.provider === 'latch') _issueStore.updateStatus(issue.id, 'in_progress')
    return
  }

  try {
    const token = await getProviderToken(issue.provider)
    if (!token) return

    if (issue.provider === 'github') {
      await github.githubPostComment(token, issue.ref, 'Latch agent has started working on this issue.')
    } else {
      await linear.linearUpdateStatus(token, issue.id.replace('linear:', ''), 'in_progress')
    }
    _issueStore.updateStatus(issue.id, 'in_progress')
  } catch (err) {
    console.warn('[issue-sync] Failed to sync session start:', err)
  }
}

/** Called when a checkpoint is created. Post progress comment. */
export async function issueSyncOnCheckpoint(sessionId: string, summary: string): Promise<void> {
  if (!_issueStore || !_secretStore) return
  const issue = _issueStore.findBySession(sessionId)
  if (!issue || issue.provider === 'latch') return

  try {
    const token = await getProviderToken(issue.provider)
    if (!token) return

    const body = `**Latch checkpoint:** ${summary}`
    if (issue.provider === 'github') {
      await github.githubPostComment(token, issue.ref, body)
    } else {
      await linear.linearPostComment(token, issue.id.replace('linear:', ''), body)
    }
  } catch (err) {
    console.warn('[issue-sync] Failed to sync checkpoint:', err)
  }
}

/** Called when a PR is created. Link it to the issue. */
export async function issueSyncOnPR(sessionId: string, prUrl: string): Promise<void> {
  if (!_issueStore || !_secretStore) return
  const issue = _issueStore.findBySession(sessionId)
  if (!issue || issue.provider === 'latch') return

  try {
    const token = await getProviderToken(issue.provider)
    if (!token) return

    if (issue.provider === 'github') {
      await github.githubLinkPR(token, issue.ref, prUrl)
    } else {
      await linear.linearLinkPR(token, issue.id.replace('linear:', ''), prUrl)
    }
  } catch (err) {
    console.warn('[issue-sync] Failed to sync PR link:', err)
  }
}

/** Called when a session ends. Mark as done/closed. */
export async function issueSyncOnSessionEnd(sessionId: string, outcome: 'done' | 'closed'): Promise<void> {
  if (!_issueStore || !_secretStore) return
  const issue = _issueStore.findBySession(sessionId)
  if (!issue) return

  if (issue.provider === 'latch') {
    _issueStore.updateStatus(issue.id, outcome)
    return
  }

  try {
    const token = await getProviderToken(issue.provider)
    if (!token) return

    if (issue.provider === 'github') {
      await github.githubPostComment(token, issue.ref, 'Latch agent has finished working on this issue.')
      if (outcome === 'done') {
        await github.githubUpdateStatus(token, issue.ref, 'closed')
      }
    } else {
      await linear.linearUpdateStatus(token, issue.id.replace('linear:', ''), outcome)
      await linear.linearPostComment(token, issue.id.replace('linear:', ''), 'Latch agent has finished working on this issue.')
    }
    _issueStore.updateStatus(issue.id, outcome)
  } catch (err) {
    console.warn('[issue-sync] Failed to sync session end:', err)
  }
}

/** Resolve the API token for a provider from SecretStore. */
async function getProviderToken(provider: string): Promise<string | null> {
  if (!_secretStore) return null
  const key = provider === 'github' ? 'service:github' : 'service:linear'
  try {
    return await _secretStore.resolveAsync(key)
  } catch {
    return _secretStore.resolve(key)
  }
}
