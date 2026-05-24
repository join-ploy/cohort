// RepositoryPane — Description field render contract.
//
// Pins the bare minimum: the Identity section renders a Description textarea
// seeded with the repo's persisted description, with the 240-char max length
// the IPC sanitizer enforces. The richer save-on-blur flow is exercised by
// the IPC-layer sanitizer test; this test only proves the field exists, is
// wired to `repo.description`, and respects the documented character cap.

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

// Why: RepositoryPane and its children read settingsSearchQuery /
// experimentalWorktreeSymlinks from useAppStore. Stub the store so the
// search filter passes through and symlinks stay hidden (this test doesn't
// touch that surface).
vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    selector
      ? selector({
          settingsSearchQuery: '',
          settings: { experimentalWorktreeSymlinks: false }
        })
      : {}
}))

// Why: BaseRefPicker and the hooks/sparse-presets sections each pull on
// window.api + electron lifecycle that isn't worth setting up for a render
// snapshot. Stub them to inert placeholders so renderToStaticMarkup gets to
// the Identity section without throwing.
vi.mock('./BaseRefPicker', () => ({ BaseRefPicker: () => null }))
vi.mock('./RepositoryHooksSection', () => ({ RepositoryHooksSection: () => null }))
vi.mock('./SparsePresetSettingsSection', () => ({ SparsePresetSettingsSection: () => null }))
vi.mock('./WorktreeSymlinksSection', () => ({ WorktreeSymlinksSection: () => null }))

import { RepositoryPane } from './RepositoryPane'

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'r1',
    path: '/repos/orca',
    displayName: 'orca',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

describe('RepositoryPane — Description field', () => {
  it('renders a Description label and textarea capped at 240 chars', () => {
    const markup = renderToStaticMarkup(
      React.createElement(RepositoryPane, {
        repo: buildRepo({ description: 'Web app frontend' }),
        yamlHooks: null,
        hasHooksFile: false,
        mayNeedUpdate: false,
        updateRepo: vi.fn(),
        removeRepo: vi.fn()
      })
    )
    expect(markup).toContain('Description')
    // Why: React preserves the `maxLength` prop name in static markup
    // (camelCase) — match either form so the assertion stays stable if a
    // future renderer normalizes attribute casing.
    expect(markup).toMatch(/max[Ll]ength="240"/)
    // Why: the textarea is the canonical surface for multi-line repo prose
    // (matches the RepositoryHooksSection pattern). An <input> here would
    // silently swallow newlines on paste.
    expect(markup).toMatch(/<textarea[^>]*>Web app frontend<\/textarea>/)
  })

  it('seeds the textarea empty when the repo has no description', () => {
    const markup = renderToStaticMarkup(
      React.createElement(RepositoryPane, {
        repo: buildRepo({ description: undefined }),
        yamlHooks: null,
        hasHooksFile: false,
        mayNeedUpdate: false,
        updateRepo: vi.fn(),
        removeRepo: vi.fn()
      })
    )
    // Empty textarea body — the placeholder copy still appears as an attr.
    expect(markup).toMatch(/<textarea[^>]*><\/textarea>/)
    expect(markup).toContain('placeholder=')
  })
})
