import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), '.latch', 'workspaces')
const DEFAULT_BRANCH_PREFIX = 'latch/'

function slugify(value: string): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export function getWorkspaceRoot(): string {
  return process.env.LATCH_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT
}

export function getBranchPrefix(): string {
  return process.env.LATCH_BRANCH_PREFIX || DEFAULT_BRANCH_PREFIX
}

export async function getGitRoot(cwd = process.cwd()): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd })
    return stdout.trim()
  } catch {
    return null
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function branchExists(repoRoot: string, branchRef: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['show-ref', '--verify', `refs/heads/${branchRef}`], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

function buildWorkspacePath(repoRoot: string, sessionName: string, branchName: string) {
  const repoBase = path.basename(repoRoot)
  const repoSlug = slugify(repoBase) || 'repo'
  const repoKey = `${repoSlug}-${shortHash(repoRoot)}`
  const sessionSlug = slugify(sessionName || branchName || 'session') || 'session'
  return {
    repoKey,
    sessionSlug,
    workspacePath: path.join(getWorkspaceRoot(), repoKey, sessionSlug)
  }
}

function normalizeBranchName(branchName: string, sessionName: string): string {
  const prefix = getBranchPrefix()
  const raw = branchName && branchName.trim() ? branchName.trim() : sessionName
  const safe = slugify(raw) || 'session'
  if (safe.startsWith(prefix)) return safe
  return `${prefix}${safe}`
}

export async function createWorktree({ repoPath, branchName, sessionName }: any) {
  const repoRoot = await getGitRoot(repoPath)
  if (!repoRoot) return { ok: false, error: 'Git repository not detected.' }

  const { workspacePath, repoKey, sessionSlug } = buildWorkspacePath(repoRoot, sessionName, branchName)
  const branchRef = normalizeBranchName(branchName, sessionName)

  if (await pathExists(workspacePath)) {
    return { ok: false, error: 'Worktree path already exists.', workspacePath, branchRef }
  }

  await ensureDir(path.dirname(workspacePath))
  const exists = await branchExists(repoRoot, branchRef)
  const args = exists
    ? ['worktree', 'add', workspacePath, branchRef]
    : ['worktree', 'add', '-b', branchRef, workspacePath]

  await execFileAsync('git', args, { cwd: repoRoot })

  return { ok: true, repoRoot, repoKey, sessionSlug, workspacePath, branchRef }
}

export async function listWorktrees(repoPath: string) {
  const repoRoot = await getGitRoot(repoPath)
  if (!repoRoot) return { ok: false, error: 'Git repository not detected.' }

  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot })

  const entries = stdout.trim().split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n')
    const entry: Record<string, string> = {}
    lines.forEach((line) => {
      const [key, ...rest] = line.split(' ')
      if (!key) return
      entry[key] = rest.join(' ').trim()
    })
    return entry
  })

  return { ok: true, repoRoot, worktrees: entries }
}

export async function removeWorktree({ repoPath, worktreePath }: any) {
  const repoRoot = await getGitRoot(repoPath)
  if (!repoRoot) return { ok: false, error: 'Git repository not detected.' }
  if (!worktreePath) return { ok: false, error: 'Worktree path required.' }

  await execFileAsync('git', ['worktree', 'remove', worktreePath], { cwd: repoRoot })
  return { ok: true }
}
