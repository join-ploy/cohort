import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'

describe('getDefaultSettings — external tool fields', () => {
  it('defaults the editor to the VS Code preset with empty commands', () => {
    const settings = getDefaultSettings('/home/tester')
    expect(settings.externalEditorKind).toBe('vscode')
    expect(settings.externalEditorCommand).toBe('')
    expect(settings.externalDiffCommand).toBe('')
    expect(settings.externalDatabaseKind).toBe('url')
    expect(settings.externalDatabaseCommand).toBe('')
  })
})
