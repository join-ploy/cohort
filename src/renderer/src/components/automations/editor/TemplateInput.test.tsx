import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { TemplateInput } from './TemplateInput'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

const SCHEMA: AvailableVariables = {
  automation: { workspaceId: 'string' },
  trigger: { firedAt: 'number' },
  steps: { cw1: { worktreeId: 'string' } }
}

describe('TemplateInput', () => {
  it('renders the value', () => {
    const markup = renderToStaticMarkup(
      <TemplateInput value="hello" onChange={() => {}} available={EMPTY_AVAIL} />
    )
    expect(markup).toMatch(/value=["']hello["']/)
  })

  it('renders as an <input> by default', () => {
    const markup = renderToStaticMarkup(
      <TemplateInput value="" onChange={() => {}} available={EMPTY_AVAIL} />
    )
    expect(markup).toMatch(/<input/)
    expect(markup).not.toMatch(/<textarea/)
  })

  it('renders as a <textarea> when multiline=true', () => {
    const markup = renderToStaticMarkup(
      <TemplateInput value="" onChange={() => {}} available={EMPTY_AVAIL} multiline />
    )
    expect(markup).toMatch(/<textarea/)
  })

  it('applies a red error class when the value has an unknown reference', () => {
    const markup = renderToStaticMarkup(
      <TemplateInput value="{{missing}}" onChange={() => {}} available={EMPTY_AVAIL} />
    )
    // Any rose-toned ring/border class indicates the error state.
    expect(markup).toMatch(/rose-\d{3}/)
  })

  it('does not apply error styling for plain text', () => {
    const markup = renderToStaticMarkup(
      <TemplateInput value="plain text" onChange={() => {}} available={EMPTY_AVAIL} />
    )
    expect(markup).not.toMatch(/rose-\d{3}/)
  })

  it('does not apply error styling for valid template references', () => {
    const markup = renderToStaticMarkup(
      <TemplateInput
        value="hi {{automation.workspaceId}} and {{steps.cw1.worktreeId}}"
        onChange={() => {}}
        available={SCHEMA}
      />
    )
    expect(markup).not.toMatch(/rose-\d{3}/)
  })

  it('renders the placeholder when value is empty', () => {
    const markup = renderToStaticMarkup(
      <TemplateInput
        value=""
        onChange={() => {}}
        available={EMPTY_AVAIL}
        placeholder="Base branch"
      />
    )
    expect(markup).toMatch(/placeholder=["']Base branch["']/)
  })

  it('does not render the popover when the value has no recent {{', () => {
    const markup = renderToStaticMarkup(
      <TemplateInput value="hello" onChange={() => {}} available={EMPTY_AVAIL} />
    )
    expect(markup).not.toMatch(/role=["']listbox["']/)
  })
})
