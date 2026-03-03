/**
 * @module github-issues
 * @description GitHub Issues provider using REST API.
 * Fetches issues, updates status, posts comments, links PRs.
 */

import type { Issue, IssueRepo } from '../../types'

const GITHUB_API = 'https://api.github.com'
const HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
})

/** Fetch repos accessible to the authenticated user. */
export async function githubListRepos(token: string): Promise<IssueRepo[]> {
  const res = await fetch(`${GITHUB_API}/user/repos?sort=updated&per_page=100`, {
    headers: HEADERS(token),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  const data = await res.json() as any[]
  return data.map((r: any) => ({
    id: String(r.id),
    name: r.name,
    fullName: r.full_name,
  }))
}

/** Fetch issues for a repo. */
export async function githubListIssues(
  token: string,
  repo: string,
  opts?: { status?: string; labels?: string[] },
): Promise<Issue[]> {
  const state = opts?.status === 'closed' ? 'closed' : 'open'
  let url = `${GITHUB_API}/repos/${repo}/issues?state=${state}&per_page=100&sort=updated`
  if (opts?.labels?.length) url += `&labels=${opts.labels.join(',')}`

  const res = await fetch(url, { headers: HEADERS(token) })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  const data = await res.json() as any[]

  // Filter out pull requests (GitHub returns PRs in the issues endpoint)
  return data
    .filter((item: any) => !item.pull_request)
    .map((item: any) => githubToIssue(item, repo))
}

/** Fetch a single issue by ref (e.g. 'owner/repo#42'). */
export async function githubGetIssue(token: string, ref: string): Promise<Issue> {
  const match = ref.match(/^(.+?)#(\d+)$/)
  if (!match) throw new Error(`Invalid GitHub issue ref: ${ref}`)
  const [, repo, number] = match

  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${number}`, {
    headers: HEADERS(token),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return githubToIssue(data, repo)
}

/** Update issue state (open/closed). */
export async function githubUpdateStatus(token: string, ref: string, status: string): Promise<void> {
  const match = ref.match(/^(.+?)#(\d+)$/)
  if (!match) throw new Error(`Invalid GitHub issue ref: ${ref}`)
  const [, repo, number] = match

  const state = status === 'done' || status === 'closed' ? 'closed' : 'open'
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${number}`, {
    method: 'PATCH',
    headers: HEADERS(token),
    body: JSON.stringify({ state }),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
}

/** Post a comment on an issue. */
export async function githubPostComment(token: string, ref: string, body: string): Promise<void> {
  const match = ref.match(/^(.+?)#(\d+)$/)
  if (!match) throw new Error(`Invalid GitHub issue ref: ${ref}`)
  const [, repo, number] = match

  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: HEADERS(token),
    body: JSON.stringify({ body }),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
}

/** Link a PR to an issue via comment. */
export async function githubLinkPR(token: string, ref: string, prUrl: string): Promise<void> {
  await githubPostComment(token, ref, `PR linked by Latch: ${prUrl}`)
}

function githubToIssue(data: any, repo: string): Issue {
  return {
    id: `github:${repo}#${data.number}`,
    provider: 'github',
    ref: `${repo}#${data.number}`,
    title: data.title,
    body: data.body || '',
    status: data.state === 'closed' ? 'closed' : 'open',
    labels: (data.labels || []).map((l: any) => l.name),
    assignee: data.assignee?.login || null,
    url: data.html_url,
    repo,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  }
}
