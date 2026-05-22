import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AutoTriggerCard,
  addCondition,
  addRule,
  removeCondition,
  removeRule,
  reorderRule,
  toggleEnabled,
  updateCondition,
  updateRule
} from './AutoTriggerCard'
import type {
  AutoTrigger,
  SerializableFieldDescriptor
} from '../../../../../shared/automations-types'

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
        fieldCatalog={fieldCatalog}
        loadOptions={noopLoadOptions}
      />
    )
    expect(/aria-label="View fired issues"[^>]*disabled/i.test(html)).toBe(true)
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
