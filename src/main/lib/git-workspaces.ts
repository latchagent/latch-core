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

export async function createWorktree({ repoPath, branchName, sessionName, startPoint, useExisting }: any) {
  const repoRoot = await getGitRoot(repoPath)
  if (!repoRoot) return { ok: false, error: 'Git repository not detected.' }

  const { workspacePath, repoKey, sessionSlug } = buildWorkspacePath(repoRoot, sessionName, branchName)
  const branchRef = useExisting ? branchName : normalizeBranchName(branchName, sessionName)

  if (await pathExists(workspacePath)) {
    // Check if it's a valid git worktree — if so, reuse it
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspacePath })
      if (stdout.trim() === 'true') {
        return { ok: true, repoRoot, repoKey, sessionSlug, workspacePath, branchRef, reused: true }
      }
    } catch { /* not a valid worktree — clean up and recreate */ }
    // Stale directory — prune git worktree refs and remove the directory
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => {})
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {})
  }

  // Ensure repo has at least one commit (empty repos have no valid HEAD)
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
  } catch {
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initial commit'], { cwd: repoRoot })
  }

  await ensureDir(path.dirname(workspacePath))
  const exists = await branchExists(repoRoot, branchRef)
  const args = exists
    ? ['worktree', 'add', workspacePath, branchRef]
    : startPoint
      ? ['worktree', 'add', '-b', branchRef, workspacePath, startPoint]
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

export async function listBranches(repoRoot: string, limit = 15): Promise<{ ok: boolean; branches?: string[]; error?: string }> {
  try {
    const { stdout } = await execFileAsync('git', [
      'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)',
      `--count=${limit}`, 'refs/heads/'
    ], { cwd: repoRoot })
    const branches = stdout.trim().split('\n').filter(Boolean)
    return { ok: true, branches }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getDefaultBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [
      'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'
    ], { cwd: repoRoot })
    return stdout.trim().replace(/^origin\//, '')
  } catch { /* no remote HEAD configured */ }
  for (const c of ['main', 'master']) {
    if (await branchExists(repoRoot, c)) return c
  }
  return 'main'
}

export async function mergeBranch({ repoRoot, branchRef, worktreePath }: {
  repoRoot: string; branchRef: string; worktreePath?: string | null
}): Promise<{ ok: boolean; defaultBranch?: string; error?: string }> {
  // 1. Remove worktree (frees the branch for checkout)
  if (worktreePath) {
    try {
      await execFileAsync('git', ['worktree', 'remove', worktreePath], { cwd: repoRoot })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('is not a working tree')) {
        // Force remove as fallback
        try { await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot }) }
        catch { /* best-effort */ }
      }
    }
  }

  // 2. Detect default branch
  const defaultBranch = await getDefaultBranch(repoRoot)

  // 3. Record current branch for restore
  let originalBranch: string | null = null
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot })
    originalBranch = stdout.trim() || null
  } catch { /* detached HEAD is fine */ }

  // 4. Checkout default branch
  try {
    await execFileAsync('git', ['checkout', defaultBranch], { cwd: repoRoot })
  } catch (err: unknown) {
    return { ok: false, defaultBranch, error: `Checkout failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  // 5. Merge the feature branch
  try {
    await execFileAsync('git', ['merge', branchRef, '--no-edit'], { cwd: repoRoot })
  } catch (err: unknown) {
    // Conflict — abort merge and restore original branch
    await execFileAsync('git', ['merge', '--abort'], { cwd: repoRoot }).catch(() => {})
    if (originalBranch) {
      await execFileAsync('git', ['checkout', originalBranch], { cwd: repoRoot }).catch(() => {})
    }
    return { ok: false, defaultBranch, error: `Merge conflict — resolve manually on branch ${branchRef}` }
  }

  // 6. Delete the merged branch
  try { await execFileAsync('git', ['branch', '-d', branchRef], { cwd: repoRoot }) } catch { /* best-effort */ }

  // 7. Restore original branch if it was different
  if (originalBranch && originalBranch !== defaultBranch && originalBranch !== branchRef) {
    await execFileAsync('git', ['checkout', originalBranch], { cwd: repoRoot }).catch(() => {})
  }

  return { ok: true, defaultBranch }
}

export async function removeWorktree({ repoPath, worktreePath }: any) {
  if (!worktreePath) return { ok: false, error: 'Worktree path required.' }

  // Resolve the parent repo root — prefer explicit repoPath, fall back to
  // deriving it from the worktree's own .git file (which points to the parent).
  const repoRoot = await getGitRoot(repoPath || worktreePath)
  if (!repoRoot) return { ok: false, error: 'Git repository not detected.' }

  try {
    await execFileAsync('git', ['worktree', 'remove', worktreePath], { cwd: repoRoot })
  } catch {
    // Worktree may already be partially removed — force cleanup
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot })
    } catch {
      // Last resort: prune stale worktree entries
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => {})
    }
  }
  return { ok: true }
}
