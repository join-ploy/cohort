import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConditionRow, resetConditionForField } from './ConditionRow'
import type {
  Condition,
  SerializableFieldDescriptor
} from '../../../../../shared/automations-types'

const linearCatalog: SerializableFieldDescriptor[] = [
  {
    field: 'linear.assignee',
    label: 'Assignee',
    valueKind: 'user',
    ops: ['is', 'is-not', 'is-any-of'],
    hasFetchOptions: true
  },
  {
    field: 'linear.tag',
    label: 'Has tag',
    valueKind: 'label',
    ops: ['contains-any', 'contains-all'],
    hasFetchOptions: true
  },
  {
    field: 'linear.priority',
    label: 'Priority',
    valueKind: 'priority',
    ops: ['eq', 'gte', 'lte', 'is-any-of'],
    hasFetchOptions: true
  }
]

const noopLoadOptions = async (): Promise<{ value: string; label: string }[]> => []

describe('ConditionRow rendering', () => {
  it('renders all field labels in the field select', () => {
    const cond: Condition = { field: 'linear.assignee', op: 'is', value: '' }
    const html = renderToStaticMarkup(
      <ConditionRow
        condition={cond}
        fieldCatalog={linearCatalog}
        loadOptions={noopLoadOptions}
        onChange={() => {}}
        onRemove={() => {}}
      />
    )
    expect(html).toContain('Assignee')
    expect(html).toContain('Has tag')
    expect(html).toContain('Priority')
  })

  it('op select only lists ops allowed by the chosen field', () => {
    const cond: Condition = { field: 'linear.assignee', op: 'is', value: '' }
    const html = renderToStaticMarkup(
      <ConditionRow
        condition={cond}
        fieldCatalog={linearCatalog}
        loadOptions={noopLoadOptions}
        onChange={() => {}}
        onRemove={() => {}}
      />
    )
    expect(html).toContain('is any of')
    expect(html).toContain('is not')
    // Priority-only ops should not appear for the Assignee field.
    expect(html).not.toContain('≥')
    expect(html).not.toContain('≤')
  })

  it('value editor switches by valueKind', () => {
    const condUser: Condition = { field: 'linear.assignee', op: 'is', value: '' }
    const htmlUser = renderToStaticMarkup(
      <ConditionRow
        condition={condUser}
        fieldCatalog={linearCatalog}
        loadOptions={noopLoadOptions}
        onChange={() => {}}
        onRemove={() => {}}
      />
    )
    expect(htmlUser).toMatch(/<select\s[^>]*aria-label="Value"/)

    // Why: multi-ops switched from a native <select multiple> to a chip-based
    // picker — assert on the picker's container + add-value affordance rather
    // than the removed `multiple` HTML attribute.
    const condMulti: Condition = { field: 'linear.assignee', op: 'is-any-of', value: [] }
    const htmlMulti = renderToStaticMarkup(
      <ConditionRow
        condition={condMulti}
        fieldCatalog={linearCatalog}
        loadOptions={noopLoadOptions}
        onChange={() => {}}
        onRemove={() => {}}
      />
    )
    expect(htmlMulti).toMatch(/aria-label="Value"/)
    expect(htmlMulti).toContain('Add value')
  })

  it('renders remove button', () => {
    const cond: Condition = { field: 'linear.assignee', op: 'is', value: '' }
    const html = renderToStaticMarkup(
      <ConditionRow
        condition={cond}
        fieldCatalog={linearCatalog}
        loadOptions={noopLoadOptions}
        onChange={() => {}}
        onRemove={() => {}}
      />
    )
    expect(html).toContain('Remove condition')
  })

  it('renders a numeric input when valueKind is number', () => {
    const numericCatalog: SerializableFieldDescriptor[] = [
      {
        field: 'numeric.estimate',
        label: 'Estimate',
        valueKind: 'number',
        ops: ['eq', 'gte', 'lte'],
        hasFetchOptions: false
      }
    ]
    const cond: Condition = { field: 'numeric.estimate', op: 'eq', value: 0 }
    const html = renderToStaticMarkup(
      <ConditionRow
        condition={cond}
        fieldCatalog={numericCatalog}
        loadOptions={noopLoadOptions}
        onChange={() => {}}
        onRemove={() => {}}
      />
    )
    expect(html).toMatch(/<input[^>]*type="number"[^>]*aria-label="Value"/)
  })
})

describe('resetConditionForField pure helper', () => {
  it('resets op to descriptor.ops[0] when current op not allowed', () => {
    const cond: Condition = { field: 'old', op: 'gte', value: 5 }
    const newDescriptor: SerializableFieldDescriptor = {
      field: 'linear.assignee',
      label: 'Assignee',
      valueKind: 'user',
      ops: ['is', 'is-not'],
      hasFetchOptions: true
    }
    const result = resetConditionForField(cond, newDescriptor)
    expect(result.field).toBe('linear.assignee')
    expect(result.op).toBe('is')
    expect(result.value).toBe('')
  })

  it('keeps op when allowed; clears value to type-appropriate default for number', () => {
    const cond: Condition = { field: 'old', op: 'eq', value: 'foo' }
    const newDescriptor: SerializableFieldDescriptor = {
      field: 'numeric.estimate',
      label: 'Estimate',
      valueKind: 'number',
      ops: ['eq', 'gte', 'lte'],
      hasFetchOptions: false
    }
    const result = resetConditionForField(cond, newDescriptor)
    expect(result.op).toBe('eq')
    expect(result.value).toBe(0)
  })

  it('clears value to [] for multi-ops', () => {
    const cond: Condition = { field: 'old', op: 'is-any-of', value: ['x'] }
    const newDescriptor: SerializableFieldDescriptor = {
      field: 'linear.tag',
      label: 'Has tag',
      valueKind: 'label',
      ops: ['is-any-of', 'contains-any'],
      hasFetchOptions: true
    }
    const result = resetConditionForField(cond, newDescriptor)
    expect(result.op).toBe('is-any-of')
    expect(result.value).toEqual([])
  })

  it('falls back to the descriptor first op when current op is not allowed and chooses a string default', () => {
    const cond: Condition = { field: 'old', op: 'contains-all', value: ['a', 'b'] }
    const newDescriptor: SerializableFieldDescriptor = {
      field: 'linear.state',
      label: 'State',
      valueKind: 'state',
      ops: ['is', 'is-any-of'],
      hasFetchOptions: true
    }
    const result = resetConditionForField(cond, newDescriptor)
    expect(result.op).toBe('is')
    expect(result.value).toBe('')
  })
})
