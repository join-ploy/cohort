// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ExternalToolsSection } from './ExternalToolsSection'

// Why: vitest's global environment is 'node' with no setupFiles, so the jsdom
// docblock above is required for `render`, and auto-cleanup is off — tear down
// manually between tests or accumulated DOM makes getByLabelText ambiguous.
afterEach(() => cleanup())

function setup(overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn()
  render(
    <ExternalToolsSection
      editorKind="vscode"
      editorCommand=""
      diffCommand=""
      databaseKind="url"
      databaseCommand=""
      onChange={onChange}
      {...overrides}
    />
  )
  return { onChange }
}

describe('ExternalToolsSection', () => {
  it('hides the editor command field while the VS Code preset is selected', () => {
    setup({ editorKind: 'vscode' })
    expect(screen.queryByLabelText('Editor command')).toBeNull()
  })

  it('shows the editor command field when the custom kind is selected', () => {
    setup({ editorKind: 'custom', editorCommand: 'emacsclient' })
    expect(screen.getByLabelText('Editor command')).toBeTruthy()
  })

  it('commits an edited diff command on blur', () => {
    const { onChange } = setup({ diffCommand: '' })
    const field = screen.getByLabelText('Diff command') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'emacsclient diff' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith({ externalDiffCommand: 'emacsclient diff' })
  })

  it('shows the database command field only for the custom kind', () => {
    setup({ databaseKind: 'custom', databaseCommand: '' })
    expect(screen.getByLabelText('Database command')).toBeTruthy()
  })
})
