import type { LinearClient } from '@linear/sdk'
import type { CandidateEvent, FieldDescriptor, PollCtx, TriggerSource } from './types'

export type LinearIssueSourceDeps = {
  client: LinearClient | null
}

const PAGE_SIZE = 50
const MAX_PAGES = 5

export function makeLinearIssueSource(deps: LinearIssueSourceDeps): TriggerSource {
  const fieldCatalog: FieldDescriptor[] = [
    {
      field: 'linear.assignee',
      label: 'Assignee',
      valueKind: 'user',
      ops: ['is', 'is-not', 'is-any-of', 'is-none-of'],
      // Stubbed in 6.1; 6.3 fills in viewer + team-members lookup.
      fetchOptions: async () => []
    },
    {
      field: 'linear.tag',
      label: 'Has tag',
      valueKind: 'label',
      ops: ['contains-any', 'contains-all', 'contains-none'],
      fetchOptions: async () => []
    },
    {
      field: 'linear.state',
      label: 'State',
      valueKind: 'state',
      ops: ['is', 'is-any-of', 'is-none-of'],
      fetchOptions: async () => []
    },
    {
      field: 'linear.priority',
      label: 'Priority',
      valueKind: 'priority',
      ops: ['eq', 'is-any-of', 'gte', 'lte'],
      fetchOptions: async () => [
        { value: '0', label: 'No priority' },
        { value: '1', label: 'Urgent' },
        { value: '2', label: 'High' },
        { value: '3', label: 'Medium' },
        { value: '4', label: 'Low' }
      ]
    }
  ]

  return {
    id: 'linear-issue',
    displayName: 'Linear issue',
    fieldCatalog,
    poll: (ctx) => pollLinearIssues(deps.client, ctx)
  }
}

// Why: use `client.issues({ filter: { updatedAt } })` (workspace-wide) rather
// than `client.viewer.assignedIssues` so the engine sees issues assigned to
// any user — the rule editor lets users target arbitrary assignees, so a
// viewer-scoped poll would silently miss those rules. More API traffic now;
// scope tuning is a follow-up.
async function* pollLinearIssues(
  client: LinearClient | null,
  ctx: PollCtx
): AsyncIterable<CandidateEvent> {
  if (!client) {
    return
  }
  try {
    let after: string | undefined = undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const conn = await client.issues({
        first: PAGE_SIZE,
        after,
        filter: { updatedAt: { gte: new Date(ctx.since) } }
      })
      for (const issue of conn.nodes) {
        const event = await mapIssueToEvent(issue as unknown as IssueLike)
        if (event) {
          yield event
        }
      }
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) {
        break
      }
      after = conn.pageInfo.endCursor
    }
  } catch (err) {
    console.warn('[linear-issue source] poll failed:', err)
  }
}

// The Linear SDK returns `assignee`, `state`, `team` as Promises and `labels`
// as a function returning a Promise — await each before mapping.
type IssueLike = {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  updatedAt: string | Date
  priority: number
  assignee: Promise<{ id: string; email?: string | null; displayName?: string } | null>
  state: Promise<{ name: string } | null>
  labels: () => Promise<{ nodes: { id: string; name: string }[] }>
}

async function mapIssueToEvent(issue: IssueLike): Promise<CandidateEvent | null> {
  const [assignee, state, labelConn] = await Promise.all([
    issue.assignee,
    issue.state,
    issue.labels()
  ])
  const labelNames = labelConn.nodes.map((l) => l.name)
  const stateName = state?.name ?? ''
  const updatedAtMs = new Date(issue.updatedAt).getTime()
  return {
    entityId: issue.id,
    entityIdentifier: issue.identifier,
    updatedAt: updatedAtMs,
    payload: {
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        url: issue.url,
        assigneeEmail: assignee?.email ?? '',
        stateName,
        priority: issue.priority
      }
    },
    fields: {
      'linear.assignee': assignee?.id ?? undefined,
      'linear.tag': labelNames,
      'linear.state': stateName,
      'linear.priority': issue.priority
    }
  }
}
