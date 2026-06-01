import { describe, expect, it } from 'vitest'
import {
  getConfiguredToolCommand,
  substituteToolPlaceholders,
  type WorktreeToolPlaceholders
} from './resolve-worktree-tool-command'
import { getDefaultSettings } from '../../shared/constants'

const VALUES: WorktreeToolPlaceholders = {
  WORKTREE_PATH: '/wt/my feature',
  WORKSPACE_NAME: 'wise_panther',
  WORKSPACE_DISPLAY_NAME: 'plo-3884 my feature',
  REPO_PATH: '/repo',
  BASE_BRANCH: 'main',
  MERGE_BASE: 'abc123',
  HEAD: 'def456'
}

describe('substituteToolPlaceholders', () => {
  it('substitutes every placeholder, preserving spaces verbatim', () => {
    const out = substituteToolPlaceholders(
      'emacsclient -n -e \'(magit-status "${WORKTREE_PATH}")\'',
      VALUES
    )
    expect(out).toBe('emacsclient -n -e \'(magit-status "/wt/my feature")\'')
  })

  it('substitutes the workspace display name distinctly from the git-safe name', () => {
    expect(
      substituteToolPlaceholders('${WORKSPACE_NAME} / ${WORKSPACE_DISPLAY_NAME}', VALUES)
    ).toBe('wise_panther / plo-3884 my feature')
  })

  it('substitutes git refs', () => {
    expect(substituteToolPlaceholders('${MERGE_BASE}..${HEAD}', VALUES)).toBe('abc123..def456')
  })

  it('leaves ${DATABASE_URL} unsubstituted — it is deliberately not a placeholder', () => {
    // Why: repo-sourced data must never reach a shell:true command (injection).
    expect(substituteToolPlaceholders('db ${DATABASE_URL}', VALUES)).toBe('db ${DATABASE_URL}')
  })

  it('leaves unknown placeholders untouched', () => {
    expect(substituteToolPlaceholders('${WORKTREE_PATH} ${NOPE}', VALUES)).toBe(
      '/wt/my feature ${NOPE}'
    )
  })

  it('replaces repeated placeholders', () => {
    expect(substituteToolPlaceholders('${HEAD} ${HEAD}', VALUES)).toBe('def456 def456')
  })
})

describe('getConfiguredToolCommand', () => {
  it('returns the command string for each tool', () => {
    const settings = {
      ...getDefaultSettings('/home/tester'),
      externalEditorCommand: 'edit',
      externalDiffCommand: 'diff',
      externalDatabaseCommand: 'db'
    }
    expect(getConfiguredToolCommand(settings, 'editor')).toBe('edit')
    expect(getConfiguredToolCommand(settings, 'diff')).toBe('diff')
    expect(getConfiguredToolCommand(settings, 'database')).toBe('db')
  })
})
