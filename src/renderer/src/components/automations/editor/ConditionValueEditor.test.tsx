// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MultiValuePicker, SingleValuePicker } from './ConditionValueEditor'
import type {
  Condition,
  SerializableFieldDescriptor
} from '../../../../../shared/automations-types'

const tagDescriptor: SerializableFieldDescriptor = {
  field: 'linear.tag',
  label: 'Has tag',
  valueKind: 'label',
  ops: ['contains-any', 'contains-all'],
  hasFetchOptions: true
}

const assigneeDescriptor: SerializableFieldDescriptor = {
  field: 'linear.assignee',
  label: 'Assignee',
  valueKind: 'user',
  ops: ['is', 'is-not'],
  hasFetchOptions: true
}

describe('MultiValuePicker refresh-on-open', () => {
  it('passes { force: true } to loadOptions when the dropdown opens', async () => {
    const loadOptions = vi
      .fn<
        (field: string, opts?: { force?: boolean }) => Promise<{ value: string; label: string }[]>
      >()
      .mockResolvedValue([])
    const condition: Condition = { field: 'linear.tag', op: 'contains-any', value: [] }

    render(
      <MultiValuePicker
        condition={condition}
        descriptor={tagDescriptor}
        loadOptions={loadOptions}
        onValueChange={() => {}}
      />
    )

    // Wait for the initial (non-force) mount load to settle so we can assert
    // cleanly on the open-triggered call.
    await waitFor(() => {
      expect(loadOptions).toHaveBeenCalledWith('linear.tag')
    })

    fireEvent.click(screen.getByRole('button', { name: /Add value/i }))

    await waitFor(() => {
      expect(loadOptions).toHaveBeenCalledWith('linear.tag', { force: true })
    })
  })
})

describe('SingleValuePicker refresh-on-open', () => {
  it('passes { force: true } to loadOptions on select mousedown', async () => {
    const loadOptions = vi
      .fn<
        (field: string, opts?: { force?: boolean }) => Promise<{ value: string; label: string }[]>
      >()
      .mockResolvedValue([])
    const condition: Condition = { field: 'linear.assignee', op: 'is', value: '' }

    const { container } = render(
      <SingleValuePicker
        condition={condition}
        descriptor={assigneeDescriptor}
        loadOptions={loadOptions}
        onValueChange={() => {}}
      />
    )

    await waitFor(() => {
      expect(loadOptions).toHaveBeenCalledWith('linear.assignee')
    })

    fireEvent.mouseDown(container.querySelector('select[aria-label="Value"]') as HTMLSelectElement)

    await waitFor(() => {
      expect(loadOptions).toHaveBeenCalledWith('linear.assignee', { force: true })
    })
  })
})
