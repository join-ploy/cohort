import type { LinearClient } from '@linear/sdk'
import type { CandidateEvent, FieldDescriptor, TriggerSource } from './types'

export type LinearIssueSourceDeps = {
  client: LinearClient | null
}

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

  // Quiet the unused-parameter warning until 6.2 wires the client in.
  void deps

  return {
    id: 'linear-issue',
    displayName: 'Linear issue',
    fieldCatalog,
    async *poll(): AsyncIterable<CandidateEvent> {
      // 6.2 fills this in.
    }
  }
}
