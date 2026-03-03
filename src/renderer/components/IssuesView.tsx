/**
 * @module IssuesView
 * @description Browse and manage issues from Latch, GitHub, and Linear.
 * Linear-style flat list with accordion expand for details.
 */

import React, { useEffect, useState } from 'react'
import { Circle, CircleDashed, CheckCircle, CircleHalf, CaretRight, ArrowSquareOut, Trash, Play } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'
import type { Issue, IssueProvider } from '../../types'

/* ── Status icon helper ──────────────────────────────────────────────────── */

function StatusIcon({ status }: { status: Issue['status'] }) {
  switch (status) {
    case 'open':       return <Circle size={14} weight="regular" className="issue-status-icon is-open" />
    case 'in_progress': return <CircleHalf size={14} weight="fill" className="issue-status-icon is-progress" />
    case 'done':       return <CheckCircle size={14} weight="fill" className="issue-status-icon is-done" />
    case 'closed':     return <CheckCircle size={14} weight="fill" className="issue-status-icon is-closed" />
    default:           return <CircleDashed size={14} weight="regular" className="issue-status-icon" />
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/* ── Issue Row ───────────────────────────────────────────────────────────── */

function IssueRow({ issue, onStart, onJump, onDelete }: {
  issue: Issue
  onStart: () => void
  onJump?: () => void
  onDelete?: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`issue-row${expanded ? ' is-expanded' : ''}`}>
      <div className="issue-row-main" onClick={() => setExpanded(!expanded)}>
        <CaretRight
          size={12}
          weight="bold"
          className={`issue-row-caret${expanded ? ' is-open' : ''}`}
        />
        <span className="issue-row-ref">{issue.ref}</span>
        <StatusIcon status={issue.status} />
        <span className="issue-row-title">{issue.title}</span>
        {issue.labels.length > 0 && (
          <span className="issue-row-label">{issue.labels[0]}</span>
        )}
        <span className="issue-row-spacer" />
        {issue.provider !== 'latch' && (
          <span className="issue-row-provider">{issue.provider}</span>
        )}
        <span className="issue-row-date">{formatDate(issue.updatedAt)}</span>
      </div>

      {expanded && (
        <div className="issue-row-detail">
          {issue.body ? (
            <div className="issue-row-body">{issue.body}</div>
          ) : (
            <div className="issue-row-body is-empty">No description</div>
          )}
          <div className="issue-row-actions">
            {onDelete && (
              <button className="issue-row-action is-danger" onClick={onDelete} title="Delete">
                <Trash size={13} weight="regular" />
                Delete
              </button>
            )}
            {issue.url && (
              <button className="issue-row-action" onClick={() => window.latch?.openExternal?.(issue.url)}>
                <ArrowSquareOut size={13} weight="regular" />
                Open
              </button>
            )}
            {issue.sessionId ? (
              <button className="issue-row-action is-linked" onClick={onJump}>
                <Play size={13} weight="fill" />
                Jump to Session
              </button>
            ) : (
              <button className="issue-row-action is-primary" onClick={onStart}>
                <Play size={13} weight="fill" />
                Start Session
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── New Issue Modal ──────────────────────────────────────────────────────── */

function NewIssueModal({ onClose }: { onClose: () => void }) {
  const {
    issuesRepos,
    issuesLoading,
    issuesList,
    issuesError,
    setIssuesProvider,
    loadIssues,
    createLatchTask,
    openIssueStartDialog,
  } = useAppStore()

  const [tab, setTab] = useState<IssueProvider>('latch')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [projectDir, setProjectDir] = useState('')
  const [branchName, setBranchName] = useState('')
  const [selectedRepo, setSelectedRepo] = useState('')

  const handleTabSwitch = (provider: IssueProvider) => {
    setTab(provider)
    setSelectedRepo('')
    setIssuesProvider(provider)
  }

  const handlePickDir = async () => {
    const result = await window.latch?.pickDirectory?.()
    if (result && !result.cancelled && result.filePath) {
      setProjectDir(result.filePath)
    }
  }

  const handleCreateLatch = async () => {
    if (!title.trim()) return
    await createLatchTask({
      title: title.trim(),
      body: body.trim() || undefined,
      projectDir: projectDir || undefined,
      branchName: branchName || undefined,
    })
    onClose()
  }

  const handleRepoSelect = (repoKey: string) => {
    setSelectedRepo(repoKey)
    if (repoKey) loadIssues(repoKey)
  }

  const handleImportAndStart = (issue: Issue) => {
    onClose()
    openIssueStartDialog(issue)
  }

  const tabs: { id: IssueProvider; label: string }[] = [
    { id: 'latch', label: 'Create Task' },
    { id: 'github', label: 'Import from GitHub' },
    { id: 'linear', label: 'Import from Linear' },
  ]

  return (
    <div className="issue-modal-overlay" onClick={onClose}>
      <div className="issue-modal" onClick={(e) => e.stopPropagation()}>
        <div className="issue-modal-header">
          <h3 className="issue-modal-title">New Issue</h3>
          <button className="issue-modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="issue-modal-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`issue-modal-tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => handleTabSwitch(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="issue-modal-body">
          {tab === 'latch' && (
            <div className="issue-modal-form">
              <div className="issue-modal-field">
                <label className="issue-modal-label">Title</label>
                <input
                  className="issue-modal-input"
                  placeholder="Task title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="issue-modal-field">
                <label className="issue-modal-label">Description</label>
                <textarea
                  className="issue-modal-textarea"
                  placeholder="What should the agent do?"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={3}
                />
              </div>
              <div className="issue-modal-row">
                <div className="issue-modal-field">
                  <label className="issue-modal-label">Project directory</label>
                  <div className="issue-modal-dir-row">
                    <input
                      className="issue-modal-input"
                      placeholder="~/code/my-project"
                      value={projectDir}
                      onChange={(e) => setProjectDir(e.target.value)}
                    />
                    <button className="issue-modal-browse" onClick={handlePickDir}>Browse</button>
                  </div>
                </div>
                <div className="issue-modal-field">
                  <label className="issue-modal-label">Branch name</label>
                  <input
                    className="issue-modal-input"
                    placeholder="fix/my-feature"
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                  />
                </div>
              </div>
              <div className="issue-modal-actions">
                <button className="issue-modal-cancel" onClick={onClose}>Cancel</button>
                <button className="issue-modal-submit" onClick={handleCreateLatch} disabled={!title.trim()}>
                  Create Task
                </button>
              </div>
            </div>
          )}

          {tab !== 'latch' && (
            <div className="issue-modal-import">
              {issuesRepos.length === 0 && !issuesLoading && (
                <div className="issue-modal-empty">
                  No {tab === 'github' ? 'repositories' : 'teams'} found.
                  Configure your {tab === 'github' ? 'GitHub' : 'Linear'} API key in Settings.
                </div>
              )}
              {issuesRepos.length > 0 && (
                <div className="issue-modal-field">
                  <label className="issue-modal-label">
                    {tab === 'github' ? 'Repository' : 'Team'}
                  </label>
                  <select
                    className="issue-modal-select"
                    value={selectedRepo}
                    onChange={(e) => handleRepoSelect(e.target.value)}
                  >
                    <option value="">
                      Select {tab === 'github' ? 'a repository' : 'a team'}...
                    </option>
                    {issuesRepos.map((repo) => (
                      <option key={repo.id} value={tab === 'github' ? repo.fullName : repo.id}>
                        {repo.fullName || repo.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {issuesError && (
                <div className="issue-modal-error">{issuesError}</div>
              )}

              {issuesLoading && (
                <div className="issue-modal-loading">Loading issues...</div>
              )}

              {!issuesLoading && selectedRepo && issuesList.length === 0 && (
                <div className="issue-modal-empty">No open issues found.</div>
              )}

              {!issuesLoading && issuesList.length > 0 && (
                <div className="issue-modal-issue-list">
                  {issuesList.map((issue) => (
                    <div key={issue.id} className="issue-modal-issue-row">
                      <div className="issue-modal-issue-info">
                        <span className="issue-modal-issue-ref">{issue.ref}</span>
                        <span className="issue-modal-issue-title">{issue.title}</span>
                      </div>
                      <button
                        className="issue-modal-issue-import"
                        onClick={() => handleImportAndStart(issue)}
                      >
                        Start Session
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Start Session Dialog ─────────────────────────────────────────────────── */

function StartSessionDialog() {
  const {
    issueStartDialogIssue: issue,
    issueStartProjectDir,
    issueStartBranchName,
    setIssueStartProjectDir,
    setIssueStartBranchName,
    confirmIssueStart,
    closeIssueStartDialog,
  } = useAppStore()

  if (!issue) return null

  const handlePickDir = async () => {
    const result = await window.latch?.pickDirectory?.()
    if (result && !result.cancelled && result.filePath) {
      setIssueStartProjectDir(result.filePath)
    }
  }

  return (
    <div className="issue-modal-overlay" onClick={closeIssueStartDialog}>
      <div className="issue-modal" onClick={(e) => e.stopPropagation()}>
        <div className="issue-modal-header">
          <h3 className="issue-modal-title">Start Session</h3>
          <button className="issue-modal-close" onClick={closeIssueStartDialog}>&times;</button>
        </div>

        <div className="issue-modal-body">
          <div className="issue-modal-issue-preview">
            <span className="issue-modal-issue-ref">{issue.ref}</span>
            <span className="issue-modal-issue-title">{issue.title}</span>
          </div>

          <div className="issue-modal-form">
            <div className="issue-modal-field">
              <label className="issue-modal-label">Project directory</label>
              <div className="issue-modal-dir-row">
                <input
                  className="issue-modal-input"
                  placeholder="~/code/my-project"
                  value={issueStartProjectDir || ''}
                  onChange={(e) => setIssueStartProjectDir(e.target.value)}
                />
                <button className="issue-modal-browse" onClick={handlePickDir}>Browse</button>
              </div>
            </div>

            <div className="issue-modal-field">
              <label className="issue-modal-label">Branch name</label>
              <input
                className="issue-modal-input"
                placeholder="fix/my-feature"
                value={issueStartBranchName}
                onChange={(e) => setIssueStartBranchName(e.target.value)}
              />
            </div>

            <div className="issue-modal-field">
              <label className="issue-modal-label">Goal</label>
              <div className="issue-modal-goal-preview">
                {(issue.body || issue.title).slice(0, 300)}
              </div>
            </div>

            <div className="issue-modal-actions">
              <button className="issue-modal-cancel" onClick={closeIssueStartDialog}>Cancel</button>
              <button className="issue-modal-submit" onClick={confirmIssueStart}>
                Start Session
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Main View ────────────────────────────────────────────────────────────── */

export default function IssuesView() {
  const {
    issuesList,
    issuesLinked,
    issuesLoading,
    setIssuesProvider,
    loadIssues,
    loadLinkedIssues,
    openIssueStartDialog,
    activateSession,
    setActiveView,
    deleteLatchTask,
  } = useAppStore()

  const [showNewIssue, setShowNewIssue] = useState(false)

  useEffect(() => {
    setIssuesProvider('latch')
    loadIssues('__all__')
    loadLinkedIssues()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = (issue: Issue) => {
    if (!window.confirm(`Delete "${issue.ref}: ${issue.title}"?`)) return
    deleteLatchTask(issue.id)
  }

  const handleJump = (issue: Issue) => {
    if (issue.sessionId) {
      activateSession(issue.sessionId)
      setActiveView('home')
    }
  }

  const handleNewIssueClose = () => {
    setShowNewIssue(false)
    setIssuesProvider('latch')
    loadIssues('__all__')
    loadLinkedIssues()
  }

  // Combine all issues — add linked issues not already in the list
  const allIssues = [...issuesList]
  for (const linked of issuesLinked) {
    if (!allIssues.find(i => i.id === linked.id)) {
      allIssues.push(linked)
    }
  }

  // Group by status
  const open = allIssues.filter(i => i.status === 'open')
  const inProgress = allIssues.filter(i => i.status === 'in_progress')
  const done = allIssues.filter(i => i.status === 'done' || i.status === 'closed')

  const groups = [
    { label: 'In Progress', items: inProgress, status: 'in_progress' as const },
    { label: 'Todo', items: open, status: 'open' as const },
    { label: 'Done', items: done, status: 'done' as const },
  ].filter(g => g.items.length > 0)

  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Issues</h1>
        <div className="view-header-actions">
          <button className="view-action-btn" onClick={() => setShowNewIssue(true)}>
            New Issue
          </button>
        </div>
      </div>

      {issuesLoading && allIssues.length === 0 && (
        <div className="issues-loading">Loading...</div>
      )}

      {!issuesLoading && allIssues.length === 0 && (
        <div className="issues-empty-state">
          <div className="issues-empty-text">No issues yet</div>
          <div className="issues-empty-hint">
            Create a Latch task or import issues from GitHub or Linear.
          </div>
          <button className="issues-empty-action" onClick={() => setShowNewIssue(true)}>
            New Issue
          </button>
        </div>
      )}

      {allIssues.length > 0 && (
        <div className="issues-table">
          {groups.map((group) => (
            <div key={group.status} className="issues-group">
              <div className="issues-group-header">
                <StatusIcon status={group.status} />
                <span className="issues-group-label">{group.label}</span>
                <span className="issues-group-count">{group.items.length}</span>
              </div>
              <div className="issues-group-rows">
                {group.items.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    onStart={() => openIssueStartDialog(issue)}
                    onJump={() => handleJump(issue)}
                    onDelete={issue.provider === 'latch' ? () => handleDelete(issue) : undefined}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {showNewIssue && <NewIssueModal onClose={handleNewIssueClose} />}
      <StartSessionDialog />
    </div>
  )
}
