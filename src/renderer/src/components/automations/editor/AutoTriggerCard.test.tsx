import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AutoTriggerCard,
  addCondition,
  addRule,
  removeCondition,
  removeRule,
  reorderRule,
  setRepoIds,
  toggleEnabled,
  updateCondition,
  updateRule
} from './AutoTriggerCard'
import type {
  AutoTrigger,
  SerializableFieldDescriptor
} from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'

const mkTrigger = (overrides: Partial<AutoTrigger> = {}): AutoTrigger => ({
  id: 'at1',
  source: 'linear-issue',
  enabled: true,
  enabledAt: 0,
  rules: [],
  ...overrides
})

const projects = [
  { id: 'p1', displayName: 'orca-repo' },
  { id: 'p2', displayName: 'mobile-app' }
]

const fieldCatalog: SerializableFieldDescriptor[] = [
  {
    field: 'linear.assignee',
    label: 'Assignee',
    valueKind: 'user',
    ops: ['is', 'is-not', 'is-any-of'],
    hasFetchOptions: true
  }
]

const repos: Repo[] = [
  { id: 'r1', path: '/a', displayName: 'orca-repo', badgeColor: '#111111', addedAt: 0 },
  { id: 'r2', path: '/b', displayName: 'mobile-app', badgeColor: '#222222', addedAt: 0 }
]

const noopLoadOptions = async (): Promise<{ value: string; label: string }[]> => []

describe('AutoTriggerCard rendering', () => {
  it('renders source label and enable toggle', () => {
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={mkTrigger()}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toContain('Linear issue')
    expect(html).toMatch(/aria-label="Trigger enabled"/i)
  })

  it('renders Remove button', () => {
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={mkTrigger()}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toContain('Remove')
  })

  it('renders no rules empty state when trigger has no rules', () => {
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={mkTrigger()}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    // Why: redesign replaced the literal "+ Add rule" string with an icon +
    // label button; assert on the label text alone.
    expect(html).toContain('Add rule')
    expect(html).toContain('No rules yet')
  })

  it('renders one rule with project select + reorder buttons + delete', () => {
    const trig = mkTrigger({
      rules: [{ id: 'rl1', projectId: 'p1', conditions: [] }]
    })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toContain('orca-repo')
    expect(html).toContain('mobile-app')
    expect(html).toContain('Move up')
    expect(html).toContain('Move down')
    expect(html).toContain('Delete rule')
    // Why: redesign replaced the literal "+ Add condition" string with an
    // icon + label button; assert on the label text alone.
    expect(html).toContain('Add condition')
    expect(html).toContain('No conditions')
  })

  it('renders dedup footer with zero entries and a View button', () => {
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={mkTrigger()}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    // Why: redesign wraps the count in a <span> for typographic emphasis, so
    // the literal "Fired for 0 issues" string is broken up — match the prefix
    // and the "issues" suffix separately.
    expect(html).toContain('Fired for ')
    expect(html).toContain('>0<')
    expect(html).toContain('issues')
    expect(html).toMatch(/aria-label="View fired issues"/i)
  })

  it('disables the View button when automationId is empty', () => {
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={mkTrigger()}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(/aria-label="View fired issues"[^>]*disabled/i.test(html)).toBe(true)
  })

  it('renders the "Select project" placeholder by default', () => {
    const trig = mkTrigger({ rules: [{ id: 'rl1', projectId: '', conditions: [] }] })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toContain('Select project')
  })

  it('relaxes the per-rule project placeholder to "Inferred from group" when the chain supplies projects', () => {
    const trig = mkTrigger({ rules: [{ id: 'rl1', projectId: '', conditions: [] }] })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
        chainProvidesProject
      />
    )
    expect(html).toContain('Inferred from group')
    expect(html).not.toContain('Select project')
  })

  it('disables Move up on first rule and Move down on last rule', () => {
    const trig = mkTrigger({
      rules: [
        { id: 'rl1', projectId: 'p1', conditions: [] },
        { id: 'rl2', projectId: 'p2', conditions: [] }
      ]
    })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    // First rule: Move up disabled. Last rule: Move down disabled. Total of
    // two `disabled` attrs on reorder buttons.
    const disabledMoveUp = /aria-label="Move up"[^>]*disabled/i.test(html)
    const disabledMoveDown = /aria-label="Move down"[^>]*disabled/i.test(html)
    expect(disabledMoveUp).toBe(true)
    expect(disabledMoveDown).toBe(true)
  })
})

describe('AutoTriggerCard — github-pr watch-list', () => {
  it('renders a repo multi-select for a github-pr trigger', () => {
    const trig = mkTrigger({ source: 'github-pr', repoIds: ['r1'] })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        repos={repos}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    // The watch-list section label + the combobox trigger button.
    expect(html).toContain('Watch repositories')
    expect(html).toMatch(/role="combobox"/)
    // The selected repo's name renders in the combobox trigger label.
    expect(html).toContain('orca-repo')
  })

  it('does not render the per-rule project picker for github-pr', () => {
    const trig = mkTrigger({
      source: 'github-pr',
      repoIds: ['r1'],
      rules: [{ id: 'rl1', projectId: '', conditions: [] }]
    })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        repos={repos}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    // The per-rule project <select> carries aria-label="Project"; absent for
    // github-pr because the repo comes from the watch-list/event.
    expect(html).not.toMatch(/aria-label="Project"/)
    expect(html).not.toContain('Select project')
  })

  it('still renders the per-rule project picker for a linear-issue trigger', () => {
    const trig = mkTrigger({
      source: 'linear-issue',
      rules: [{ id: 'rl1', projectId: '', conditions: [] }]
    })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        repos={repos}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toMatch(/aria-label="Project"/)
    expect(html).toContain('Select project')
    // No watch-list for linear triggers.
    expect(html).not.toContain('Watch repositories')
  })

  it('shows the empty watch-list hint for a github-pr trigger with no repoIds', () => {
    const trig = mkTrigger({ source: 'github-pr', repoIds: [] })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        repos={repos}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toContain('Select at least one repository to watch')
  })

  it('shows the empty watch-list hint when repoIds is undefined', () => {
    const trig = mkTrigger({ source: 'github-pr' })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        repos={repos}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toContain('Select at least one repository to watch')
  })

  it('hides the empty watch-list hint once a repo is selected', () => {
    const trig = mkTrigger({ source: 'github-pr', repoIds: ['r1'] })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        repos={repos}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).not.toContain('Select at least one repository to watch')
  })

  it('never shows the empty watch-list hint for a linear-issue trigger', () => {
    const trig = mkTrigger({ source: 'linear-issue' })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        repos={repos}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).not.toContain('Select at least one repository to watch')
  })
})

describe('AutoTriggerCard — http-endpoint branch', () => {
  it('renders the HttpEndpointTriggerCard for an http-endpoint trigger', () => {
    const trig = mkTrigger({
      source: 'http-endpoint',
      pollingEnabled: true,
      manualEnabled: false,
      http: {
        request: { method: 'GET', url: '', headers: [], query: [] },
        itemsPath: null,
        fields: [],
        dedupeFields: [],
        dateGateField: null
      }
    })
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={trig}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    // The endpoint card's capability switches confirm the branch fired.
    expect(html).toContain('Poll automatically')
    expect(html).toContain('Allow manual run')
    // The linear/github dedup footer must NOT render for the http card.
    expect(html).not.toContain('Fired for ')
  })
})

describe('AutoTriggerCard — dedup footer wording', () => {
  it('uses "PRs" in the dedup footer for a github-pr trigger', () => {
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={mkTrigger({ source: 'github-pr', repoIds: ['r1'] })}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        repos={repos}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toContain('Fired for ')
    expect(html).toContain('PRs')
    // The PR footer must not fall back to issue wording.
    expect(html).not.toContain('issue')
  })

  it('uses "issues" in the dedup footer for a linear-issue trigger', () => {
    const html = renderToStaticMarkup(
      <AutoTriggerCard
        trigger={mkTrigger({ source: 'linear-issue' })}
        automationId=""
        onChange={() => {}}
        onRemove={() => {}}
        projects={projects}
        httpConnections={[]}
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(html).toContain('Fired for ')
    expect(html).toContain('issues')
    expect(html).not.toContain('PRs')
  })
})

describe('AutoTriggerCard helpers', () => {
  it('addRule appends a new rule with empty conditions', () => {
    const result = addRule(mkTrigger())
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0].conditions).toEqual([])
    expect(result.rules[0].projectId).toBe('')
    expect(typeof result.rules[0].id).toBe('string')
    expect(result.rules[0].id.length).toBeGreaterThan(0)
  })

  it('removeRule filters by id', () => {
    const trig = mkTrigger({
      rules: [
        { id: 'rl1', projectId: 'p1', conditions: [] },
        { id: 'rl2', projectId: 'p2', conditions: [] }
      ]
    })
    const result = removeRule(trig, 'rl1')
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0].id).toBe('rl2')
  })

  it('reorderRule swaps adjacent rules', () => {
    const trig = mkTrigger({
      rules: [
        { id: 'rl1', projectId: 'p1', conditions: [] },
        { id: 'rl2', projectId: 'p2', conditions: [] }
      ]
    })
    const result = reorderRule(trig, 0, 1)
    expect(result.rules.map((r) => r.id)).toEqual(['rl2', 'rl1'])
  })

  it('reorderRule is a no-op on out-of-bounds indices', () => {
    const trig = mkTrigger({
      rules: [{ id: 'rl1', projectId: 'p1', conditions: [] }]
    })
    expect(reorderRule(trig, 0, -1).rules.map((r) => r.id)).toEqual(['rl1'])
    expect(reorderRule(trig, 0, 5).rules.map((r) => r.id)).toEqual(['rl1'])
    expect(reorderRule(trig, 0, 0).rules.map((r) => r.id)).toEqual(['rl1'])
  })

  it('setRepoIds returns a new trigger with the given repoIds', () => {
    const trig = mkTrigger({ source: 'github-pr' })
    const result = setRepoIds(trig, ['r1', 'r2'])
    expect(result).not.toBe(trig)
    expect(result.repoIds).toEqual(['r1', 'r2'])
    // Original is untouched (pure helper).
    expect(trig.repoIds).toBeUndefined()
  })

  it('toggleEnabled flips the boolean', () => {
    expect(toggleEnabled(mkTrigger({ enabled: true })).enabled).toBe(false)
    expect(toggleEnabled(mkTrigger({ enabled: false })).enabled).toBe(true)
  })

  it('updateRule patches the matching rule only', () => {
    const trig = mkTrigger({
      rules: [
        { id: 'rl1', projectId: '', conditions: [] },
        { id: 'rl2', projectId: 'p2', conditions: [] }
      ]
    })
    const result = updateRule(trig, 'rl1', { projectId: 'p1' })
    expect(result.rules[0].projectId).toBe('p1')
    expect(result.rules[1].projectId).toBe('p2')
  })

  it('addCondition seeds field+op from the catalog head', () => {
    const trig = mkTrigger({
      rules: [{ id: 'rl1', projectId: '', conditions: [] }]
    })
    const result = addCondition(trig, 'rl1', fieldCatalog)
    expect(result.rules[0].conditions).toHaveLength(1)
    expect(result.rules[0].conditions[0].field).toBe('linear.assignee')
    expect(result.rules[0].conditions[0].op).toBe('is')
    expect(result.rules[0].conditions[0].value).toBe('')
  })

  it('addCondition with empty catalog still appends a placeholder row', () => {
    const trig = mkTrigger({
      rules: [{ id: 'rl1', projectId: '', conditions: [] }]
    })
    const result = addCondition(trig, 'rl1', [])
    expect(result.rules[0].conditions).toHaveLength(1)
    expect(result.rules[0].conditions[0].field).toBe('')
  })

  it('removeCondition splices by index', () => {
    const trig = mkTrigger({
      rules: [
        {
          id: 'rl1',
          projectId: '',
          conditions: [
            { field: 'linear.assignee', op: 'is', value: 'a' },
            { field: 'linear.assignee', op: 'is', value: 'b' }
          ]
        }
      ]
    })
    const result = removeCondition(trig, 'rl1', 0)
    expect(result.rules[0].conditions).toHaveLength(1)
    expect(result.rules[0].conditions[0].value).toBe('b')
  })

  it('updateCondition replaces in place', () => {
    const trig = mkTrigger({
      rules: [
        {
          id: 'rl1',
          projectId: '',
          conditions: [{ field: 'linear.assignee', op: 'is', value: 'a' }]
        }
      ]
    })
    const result = updateCondition(trig, 'rl1', 0, {
      field: 'linear.assignee',
      op: 'is-not',
      value: 'b'
    })
    expect(result.rules[0].conditions[0]).toEqual({
      field: 'linear.assignee',
      op: 'is-not',
      value: 'b'
    })
  })
})
