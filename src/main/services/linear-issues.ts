/**
 * @module linear-issues
 * @description Linear Issues provider using GraphQL API.
 * Fetches issues, updates status, posts comments, links PRs.
 */

import type { Issue, IssueRepo } from '../../types'

const LINEAR_API = 'https://api.linear.app/graphql'

/** Execute a Linear GraphQL query. */
async function linearQuery(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`)
  const json = await res.json() as any
  if (json.errors?.length) throw new Error(`Linear: ${json.errors[0].message}`)
  return json.data
}

/** List teams as repos. */
export async function linearListRepos(apiKey: string): Promise<IssueRepo[]> {
  const data = await linearQuery(apiKey, `
    query {
      teams {
        nodes {
          id
          name
          key
        }
      }
    }
  `)
  return (data.teams.nodes as any[]).map((t: any) => ({
    id: t.id,
    name: t.name,
    fullName: t.key,
  }))
}

/** List issues for a team. */
export async function linearListIssues(
  apiKey: string,
  teamId: string,
  opts?: { status?: string; labels?: string[] },
): Promise<Issue[]> {
  const data = await linearQuery(apiKey, `
    query($teamId: ID!) {
      issues(filter: { team: { id: { eq: $teamId } } }, first: 100, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          description
          state { name type }
          labels { nodes { name } }
          assignee { name }
          url
          priority
          team { key }
          createdAt
          updatedAt
        }
      }
    }
  `, { teamId })

  let issues = (data.issues.nodes as any[]).map((item: any) => linearToIssue(item))

  if (opts?.status) {
    issues = issues.filter(i => i.status === opts.status)
  }
  if (opts?.labels?.length) {
    issues = issues.filter(i => opts.labels!.some(l => i.labels.includes(l)))
  }

  return issues
}

/** Fetch a single issue by identifier (e.g. 'PROJ-123'). */
export async function linearGetIssue(apiKey: string, ref: string): Promise<Issue> {
  const data = await linearQuery(apiKey, `
    query($ref: String!) {
      issueSearch(query: $ref, first: 1) {
        nodes {
          id
          identifier
          title
          description
          state { name type }
          labels { nodes { name } }
          assignee { name }
          url
          priority
          team { key }
          createdAt
          updatedAt
        }
      }
    }
  `, { ref })

  const nodes = data.issueSearch.nodes
  if (!nodes.length) throw new Error(`Linear issue not found: ${ref}`)
  return linearToIssue(nodes[0])
}

/** Update issue state. */
export async function linearUpdateStatus(apiKey: string, issueId: string, status: string): Promise<void> {
  // Get the team's workflow states to find the right state ID
  const issueData = await linearQuery(apiKey, `
    query($id: ID!) {
      issue(id: $id) {
        team {
          states { nodes { id name type } }
        }
      }
    }
  `, { id: issueId })

  const states = issueData.issue.team.states.nodes as any[]
  const typeMap: Record<string, string> = {
    'open': 'backlog',
    'in_progress': 'started',
    'done': 'completed',
    'closed': 'cancelled',
  }
  const targetType = typeMap[status] || 'backlog'
  const targetState = states.find((s: any) => s.type === targetType)
  if (!targetState) return

  await linearQuery(apiKey, `
    mutation($id: ID!, $stateId: ID!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `, { id: issueId, stateId: targetState.id })
}

/** Post a comment on an issue. */
export async function linearPostComment(apiKey: string, issueId: string, body: string): Promise<void> {
  await linearQuery(apiKey, `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `, { issueId, body })
}

/** Link a PR via attachment. */
export async function linearLinkPR(apiKey: string, issueId: string, prUrl: string): Promise<void> {
  await linearQuery(apiKey, `
    mutation($issueId: String!, $url: String!, $title: String!) {
      attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
        success
      }
    }
  `, { issueId, url: prUrl, title: 'Pull Request (via Latch)' })
}

function linearToIssue(item: any): Issue {
  const stateType = item.state?.type || 'backlog'
  const statusMap: Record<string, Issue['status']> = {
    backlog: 'open',
    unstarted: 'open',
    started: 'in_progress',
    completed: 'done',
    cancelled: 'closed',
  }

  const priorityMap: Record<number, string> = {
    0: 'none',
    1: 'urgent',
    2: 'high',
    3: 'medium',
    4: 'low',
  }

  return {
    id: `linear:${item.id}`,
    provider: 'linear',
    ref: item.identifier,
    title: item.title,
    body: item.description || '',
    status: statusMap[stateType] || 'open',
    labels: (item.labels?.nodes || []).map((l: any) => l.name),
    assignee: item.assignee?.name || null,
    url: item.url,
    repo: item.team?.key || '',
    priority: priorityMap[item.priority] || undefined,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}
