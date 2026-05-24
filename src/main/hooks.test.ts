import type { Repo } from '../shared/types'

import { describe, expect, it, vi } from 'vitest'
import { parseConductorJson, parseOrcaYaml } from './hooks'

// Mock fs and path used by loadHooks
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

const { execMock, execFileMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: execMock,
  execFile: execFileMock,
  execFileSync: vi.fn(),
  // runner.ts imports spawn from child_process transitively.
  spawn: vi.fn()
}))

describe('parseOrcaYaml', () => {
  it('parses YAML with setup script only', () => {
    const yaml = `scripts:\n  setup: |\n    echo "setting up"\n    npm install\n`
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'echo "setting up"\nnpm install'
      }
    })
  })

  it('parses YAML with archive script only', () => {
    const yaml = `scripts:\n  archive: |\n    echo "archiving"\n`
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        archive: 'echo "archiving"'
      }
    })
  })

  it('parses YAML with both setup and archive', () => {
    const yaml = [
      'scripts:',
      '  setup: |',
      '    echo "setup"',
      '    npm install',
      '  archive: |',
      '    echo "archive"',
      '    rm -rf node_modules'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'echo "setup"\nnpm install',
        archive: 'echo "archive"\nrm -rf node_modules'
      }
    })
  })

  it('returns null when there is no scripts block', () => {
    const yaml = `other:\n  key: value\n`
    expect(parseOrcaYaml(yaml)).toBeNull()
  })

  it('parses YAML with inline scalar scripts', () => {
    const yaml = `scripts:\n  setup: npm install\n  archive: sleep 5\n`
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'npm install',
        archive: 'sleep 5'
      }
    })
  })

  it('returns null when scripts block has no setup or archive', () => {
    const yaml = `scripts:\n  unknown: |\n    echo "nope"\n`
    expect(parseOrcaYaml(yaml)).toBeNull()
  })

  it('handles multiline block scalar scripts', () => {
    const yaml = ['scripts:', '  setup: |', '    line1', '    line2', '    line3'].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'line1\nline2\nline3'
      }
    })
  })

  it('stops parsing when it hits another top-level key', () => {
    const yaml = ['scripts:', '  setup: |', '    echo "setup"', 'other:', '  key: value'].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'echo "setup"'
      }
    })
  })

  it('returns null for empty string', () => {
    expect(parseOrcaYaml('')).toBeNull()
  })

  it('parses a top-level issueCommand block scalar', () => {
    const yaml = [
      'issueCommand: |',
      '  claude -p "Read issue #{{issue}}"',
      '  codex exec "Review docs/design-{{issue}}.md"'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {},
      issueCommand:
        'claude -p "Read issue #{{issue}}"\ncodex exec "Review docs/design-{{issue}}.md"'
    })
  })

  it('parses scripts.run as a single-line string', () => {
    const yaml = `scripts:\n  run: pnpm dev\n`
    const result = parseOrcaYaml(yaml)
    expect(result?.scripts.run).toBe('pnpm dev')
  })

  it('parses scripts.run as a block scalar', () => {
    const yaml = `scripts:\n  run: |\n    pnpm install\n    pnpm dev\n`
    const result = parseOrcaYaml(yaml)
    expect(result?.scripts.run).toBe('pnpm install\npnpm dev')
  })

  it('returns null when only scripts.run is empty and no other keys exist', () => {
    const yaml = `scripts:\n  run: ''\n`
    const result = parseOrcaYaml(yaml)
    expect(result).toBeNull()
  })

  it('parses issueCommand alongside scripts', () => {
    const yaml = [
      'scripts:',
      '  setup: |',
      '    pnpm install',
      'issueCommand: |',
      '  claude -p "Read issue #{{issue}}"'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'pnpm install'
      },
      issueCommand: 'claude -p "Read issue #{{issue}}"'
    })
  })

  it('parses a top-level databaseUrl scalar', () => {
    const yaml =
      'databaseUrl: postgresql://postgres:postgres@127.0.0.1/${WORKSPACE_NAME}_server_dev\n'
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {},
      databaseUrl: 'postgresql://postgres:postgres@127.0.0.1/${WORKSPACE_NAME}_server_dev'
    })
  })

  it('parses databaseUrl alongside scripts and round-trips both', () => {
    const yaml = [
      'scripts:',
      '  run: pnpm dev',
      'databaseUrl: postgresql://postgres:postgres@127.0.0.1/${WORKSPACE_NAME}_server_dev?statusColor=F8F8F8'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: { run: 'pnpm dev' },
      databaseUrl:
        'postgresql://postgres:postgres@127.0.0.1/${WORKSPACE_NAME}_server_dev?statusColor=F8F8F8'
    })
  })

  it('strips wrapping quotes from a databaseUrl scalar', () => {
    const yaml = `databaseUrl: "postgresql://postgres@127.0.0.1/db"\n`
    const result = parseOrcaYaml(yaml)
    expect(result?.databaseUrl).toBe('postgresql://postgres@127.0.0.1/db')
  })

  it('treats a missing databaseUrl as undefined', () => {
    const yaml = `scripts:\n  run: pnpm dev\n`
    const result = parseOrcaYaml(yaml)
    expect(result?.databaseUrl).toBeUndefined()
  })

  it('treats an empty databaseUrl scalar as undefined', () => {
    // Why: a deliberately blank entry should leave the Database opener disabled
    // rather than dispatching an empty URL — same semantics as the old global
    // default for an unset template.
    const yaml = `scripts:\n  run: pnpm dev\ndatabaseUrl: ''\n`
    const result = parseOrcaYaml(yaml)
    expect(result?.databaseUrl).toBeUndefined()
  })

  it('parses an inline reviewPreferences scalar', () => {
    const yaml = `reviewPreferences: Be strict about Windows path handling.\n`
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {},
      reviewPreferences: 'Be strict about Windows path handling.'
    })
  })

  it('parses a multi-line reviewPreferences block scalar', () => {
    const yaml = [
      'reviewPreferences: |',
      '  Project conventions:',
      '  - Always quote file paths',
      '  - Surface SSH-only failure modes'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result?.reviewPreferences).toBe(
      'Project conventions:\n- Always quote file paths\n- Surface SSH-only failure modes'
    )
  })

  it('parses createPrPreferences alongside scripts and databaseUrl', () => {
    const yaml = [
      'scripts:',
      '  run: pnpm dev',
      'databaseUrl: postgresql://127.0.0.1/db',
      'createPrPreferences: |',
      '  Use Conventional Commits for the PR title.',
      '  Include a Test plan section.'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: { run: 'pnpm dev' },
      databaseUrl: 'postgresql://127.0.0.1/db',
      createPrPreferences:
        'Use Conventional Commits for the PR title.\nInclude a Test plan section.'
    })
  })

  it('parses both reviewPreferences and createPrPreferences in one file', () => {
    const yaml = [
      'reviewPreferences: |',
      '  Review guidance line.',
      'createPrPreferences: |',
      '  Create PR guidance line.'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result?.reviewPreferences).toBe('Review guidance line.')
    expect(result?.createPrPreferences).toBe('Create PR guidance line.')
  })

  it('treats an empty reviewPreferences scalar as undefined', () => {
    const yaml = `scripts:\n  run: pnpm dev\nreviewPreferences: ''\n`
    const result = parseOrcaYaml(yaml)
    expect(result?.reviewPreferences).toBeUndefined()
  })
})

describe('parseConductorJson', () => {
  it('parses scripts.setup, scripts.run, and scripts.archive from a conductor.json', () => {
    const json = JSON.stringify({
      scripts: { setup: 'npm install', run: 'npm run dev', archive: 'echo bye' }
    })
    const result = parseConductorJson(json)
    expect(result?.scripts.setup).toBe('npm install')
    expect(result?.scripts.run).toBe('npm run dev')
    expect(result?.scripts.archive).toBe('echo bye')
  })

  it('silently ignores unknown top-level keys', () => {
    const json = JSON.stringify({
      scripts: { run: 'npm run dev' },
      runScriptMode: 'nonconcurrent',
      extraField: 42
    })
    const result = parseConductorJson(json)
    expect(result?.scripts.run).toBe('npm run dev')
  })

  it('returns null for an empty object', () => {
    expect(parseConductorJson('{}')).toBeNull()
  })

  it('returns null when scripts block exists but is empty', () => {
    expect(parseConductorJson(JSON.stringify({ scripts: {} }))).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseConductorJson('{ this is not json')).toBeNull()
  })

  it('returns null when scripts is not an object', () => {
    expect(parseConductorJson(JSON.stringify({ scripts: 'pnpm dev' }))).toBeNull()
  })

  it('picks up a top-level databaseUrl alongside scripts', () => {
    const json = JSON.stringify({
      scripts: { run: 'npm run dev' },
      databaseUrl: 'postgresql://postgres@127.0.0.1/${WORKSPACE_NAME}'
    })
    const result = parseConductorJson(json)
    expect(result?.scripts.run).toBe('npm run dev')
    expect(result?.databaseUrl).toBe('postgresql://postgres@127.0.0.1/${WORKSPACE_NAME}')
  })

  it('returns hooks with only databaseUrl when scripts block is missing', () => {
    // Why: a repo can opt in to just the DB opener without authoring any
    // scripts. Returning non-null keeps the field available to the renderer.
    const json = JSON.stringify({
      scripts: {},
      databaseUrl: 'postgresql://postgres@127.0.0.1/dev'
    })
    const result = parseConductorJson(json)
    expect(result?.databaseUrl).toBe('postgresql://postgres@127.0.0.1/dev')
    expect(result?.scripts).toEqual({})
  })

  it('omits databaseUrl when missing or empty', () => {
    expect(
      parseConductorJson(JSON.stringify({ scripts: { run: 'x' } }))?.databaseUrl
    ).toBeUndefined()
    expect(
      parseConductorJson(JSON.stringify({ scripts: { run: 'x' }, databaseUrl: '' }))?.databaseUrl
    ).toBeUndefined()
  })

  it('picks up top-level reviewPreferences and createPrPreferences alongside scripts', () => {
    const json = JSON.stringify({
      scripts: { run: 'npm run dev' },
      reviewPreferences: 'Look for missing tests.',
      createPrPreferences: 'Match existing PR-title casing.'
    })
    const result = parseConductorJson(json)
    expect(result?.reviewPreferences).toBe('Look for missing tests.')
    expect(result?.createPrPreferences).toBe('Match existing PR-title casing.')
  })

  it('returns hooks with only reviewPreferences when nothing else is set', () => {
    const json = JSON.stringify({
      scripts: {},
      reviewPreferences: 'Review-only repo guidance.'
    })
    const result = parseConductorJson(json)
    expect(result?.reviewPreferences).toBe('Review-only repo guidance.')
    expect(result?.scripts).toEqual({})
  })

  it('omits review/createPr preferences when missing or empty', () => {
    expect(
      parseConductorJson(JSON.stringify({ scripts: { run: 'x' }, reviewPreferences: '' }))
        ?.reviewPreferences
    ).toBeUndefined()
    expect(
      parseConductorJson(JSON.stringify({ scripts: { run: 'x' }, createPrPreferences: '' }))
        ?.createPrPreferences
    ).toBeUndefined()
  })
})

describe('loadHooks precedence', () => {
  it('returns yaml hooks when only orca.yaml exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/orca.yaml')
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/orca.yaml') {
        return 'scripts:\n  run: pnpm dev\n'
      }
      return ''
    })

    const { loadHooks } = await import('./hooks')
    expect(loadHooks('/test/repo')?.scripts.run).toBe('pnpm dev')
  })

  it('returns conductor hooks when only conductor.json exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/conductor.json')
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/conductor.json') {
        return JSON.stringify({ scripts: { run: 'npm run dev' } })
      }
      return ''
    })

    const { loadHooks } = await import('./hooks')
    expect(loadHooks('/test/repo')?.scripts.run).toBe('npm run dev')
  })

  it('returns yaml hooks when both files exist (orca.yaml wins)', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/orca.yaml') {
        return 'scripts:\n  run: from-yaml\n'
      }
      if (path === '/test/repo/conductor.json') {
        return JSON.stringify({ scripts: { run: 'from-conductor' } })
      }
      return ''
    })

    const { loadHooks } = await import('./hooks')
    expect(loadHooks('/test/repo')?.scripts.run).toBe('from-yaml')
  })

  it('returns null when neither file exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { loadHooks } = await import('./hooks')
    expect(loadHooks('/test/repo')).toBeNull()
  })
})

describe('hasHookConfig', () => {
  it('returns true when only orca.yaml exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/orca.yaml')

    const { hasHookConfig } = await import('./hooks')
    expect(hasHookConfig('/test/repo')).toBe(true)
  })

  it('returns true when only conductor.json exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/conductor.json')

    const { hasHookConfig } = await import('./hooks')
    expect(hasHookConfig('/test/repo')).toBe(true)
  })

  it('returns true when both files exist', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)

    const { hasHookConfig } = await import('./hooks')
    expect(hasHookConfig('/test/repo')).toBe(true)
  })

  it('returns false when neither file exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { hasHookConfig } = await import('./hooks')
    expect(hasHookConfig('/test/repo')).toBe(false)
  })
})

describe('getActiveHookConfigKind', () => {
  it("returns 'orca-yaml' when both files exist", async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)

    const { getActiveHookConfigKind } = await import('./hooks')
    expect(getActiveHookConfigKind('/test/repo')).toBe('orca-yaml')
  })

  it("returns 'conductor-json' when only conductor.json exists", async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/conductor.json')

    const { getActiveHookConfigKind } = await import('./hooks')
    expect(getActiveHookConfigKind('/test/repo')).toBe('conductor-json')
  })

  it('returns null when neither file exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getActiveHookConfigKind } = await import('./hooks')
    expect(getActiveHookConfigKind('/test/repo')).toBeNull()
  })
})

describe('hasUnrecognizedOrcaYamlKeys', () => {
  it('returns true when the file contains only keys this version does not handle', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/orca.yaml')
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature: |\n  some config\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns true when an unknown key has no trailing space (block-value form)', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/orca.yaml')
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature:\n  nested: value\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns true when the file mixes recognised and unrecognised keys', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/orca.yaml')
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    pnpm install\nnewFeature: enabled\n'
    )

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns false when the file contains only recognised keys', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/orca.yaml')
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    pnpm install\nissueCommand: |\n  claude -p "test"\ndatabaseUrl: postgresql://x\n'
    )

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })

  it('returns false when conductor.json is the active config (yaml-only check)', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/conductor.json')
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ scripts: { run: 'npm run dev' }, runScriptMode: 'nonconcurrent' })
    )

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })

  it('returns false when the file is empty or has no top-level keys', async () => {
    const fs = await import('fs')
    vi.mocked(fs.readFileSync).mockReturnValue('# just a comment\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })

  it('returns false when the file cannot be read', async () => {
    const fs = await import('fs')
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })
})

describe('readIssueCommand', () => {
  it('prefers the local override over the shared orca.yaml command', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === '/test/repo/.orca/issue-command' || path === '/test/repo/orca.yaml'
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/.orca/issue-command') {
        return 'local command\n'
      }
      if (path === '/test/repo/orca.yaml') {
        return 'issueCommand: |\n  shared command\n'
      }
      return ''
    })

    const { readIssueCommand } = await import('./hooks')
    expect(readIssueCommand('/test/repo')).toEqual({
      localContent: 'local command',
      sharedContent: 'shared command',
      effectiveContent: 'local command',
      localFilePath: '/test/repo/.orca/issue-command',
      source: 'local'
    })
  })

  it('falls back to the shared orca.yaml command when no local override exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/orca.yaml')
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/orca.yaml') {
        return 'issueCommand: |\n  shared command\n'
      }
      return ''
    })

    const { readIssueCommand } = await import('./hooks')
    expect(readIssueCommand('/test/repo')).toEqual({
      localContent: null,
      sharedContent: 'shared command',
      effectiveContent: 'shared command',
      localFilePath: '/test/repo/.orca/issue-command',
      source: 'shared'
    })
  })
})

describe('writeIssueCommand', () => {
  it('writes only the local override file and keeps .orca ignored locally', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === '/test/repo/.gitignore' || path === '/test/repo/.orca'
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/.gitignore') {
        return 'node_modules/\n'
      }
      return ''
    })

    const { writeIssueCommand } = await import('./hooks')
    writeIssueCommand('/test/repo', 'local command')

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      '/test/repo/.gitignore',
      'node_modules/\n.orca\n',
      'utf-8'
    )
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      '/test/repo/.orca/issue-command',
      'local command\n',
      'utf-8'
    )
  })

  it('deletes the local override when the override is cleared', async () => {
    const fs = await import('fs')
    const { writeIssueCommand } = await import('./hooks')
    writeIssueCommand('/test/repo', '   ')

    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith('/test/repo/.orca/issue-command', {
      force: true
    })
  })
})

describe('getEffectiveHooks', () => {
  // We need to dynamically import after mocking
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
    scripts?: { setup: string; archive: string; run?: string }
  }) =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings
    }) as unknown as Repo

  it('uses hooks from orca.yaml when present', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    // Re-import to pick up mocks
    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo()
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"'
      }
    })
  })

  it("loads setup hooks from the target worktree's orca.yaml when a worktree path is provided", async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === '/test/repo/orca.yaml' || path === '/test/worktree/orca.yaml'
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/orca.yaml') {
        return 'scripts:\n  setup: |\n    echo old-version\n'
      }
      if (path === '/test/worktree/orca.yaml') {
        return 'scripts:\n  setup: |\n    echo new-version\n'
      }
      return ''
    })

    const { getEffectiveHooks } = await import('./hooks')
    const result = getEffectiveHooks(makeRepo(), '/test/worktree')

    expect(result).toEqual({
      scripts: {
        setup: 'echo new-version'
      }
    })
    expect(result?.scripts.setup).not.toContain('old-version')
  })

  it('falls back to legacy UI hooks when yaml is missing', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy ui setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "legacy ui setup"',
        archive: 'echo "legacy archive"'
      }
    })
  })

  it('ignores legacy UI override settings when yaml exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "ui override"', archive: '' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"'
      }
    })
  })

  it('falls back per hook when orca.yaml defines only one command', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  archive: |\n    echo "yaml archive"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "legacy setup"',
        archive: 'echo "yaml archive"'
      }
    })
  })

  it('falls back to legacy persisted scripts.run when yaml is missing', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: '', archive: '', run: 'echo legacy run' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        run: 'echo legacy run'
      }
    })
  })

  it('returns null when no hooks at all', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({ mode: 'auto', scripts: { setup: '', archive: '' } })
    const result = getEffectiveHooks(repo)

    expect(result).toBeNull()
  })

  it('surfaces scripts.run from orca.yaml', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  run: |\n    pnpm dev\n')

    const { getEffectiveHooks } = await import('./hooks')
    const result = getEffectiveHooks(makeRepo())

    expect(result?.scripts.run).toBe('pnpm dev')
  })

  it('returns the orca.yaml databaseUrl when no persisted override exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  run: pnpm dev\ndatabaseUrl: postgresql://yaml/db\n'
    )

    const { getEffectiveHooks } = await import('./hooks')
    const result = getEffectiveHooks(makeRepo())

    expect(result?.databaseUrl).toBe('postgresql://yaml/db')
  })

  it('returns the persisted databaseUrl override when set, overriding yaml', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  run: pnpm dev\ndatabaseUrl: postgresql://yaml/db\n'
    )

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepoWithDbOverride('postgresql://override/db')
    const result = getEffectiveHooks(repo)

    expect(result?.databaseUrl).toBe('postgresql://override/db')
  })

  it('falls back to yaml databaseUrl when the persisted override is empty', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  run: pnpm dev\ndatabaseUrl: postgresql://yaml/db\n'
    )

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepoWithDbOverride('   ')
    const result = getEffectiveHooks(repo)

    expect(result?.databaseUrl).toBe('postgresql://yaml/db')
  })

  it('omits databaseUrl when neither yaml nor persisted override define one', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  run: pnpm dev\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepoWithDbOverride('')
    const result = getEffectiveHooks(repo)

    expect(result?.databaseUrl).toBeUndefined()
  })

  it('returns hooks containing only databaseUrl when no scripts are configured', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepoWithDbOverride('postgresql://override-only/db')
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {},
      databaseUrl: 'postgresql://override-only/db'
    })
  })

  it('returns yaml reviewPreferences and createPrPreferences when no overrides exist', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        'reviewPreferences: |',
        '  Review yaml line.',
        'createPrPreferences: |',
        '  Create PR yaml line.'
      ].join('\n')
    )

    const { getEffectiveHooks } = await import('./hooks')
    const result = getEffectiveHooks(makeRepo())

    expect(result?.reviewPreferences).toBe('Review yaml line.')
    expect(result?.createPrPreferences).toBe('Create PR yaml line.')
  })

  it('lets the persisted reviewPreferences override the yaml value', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      ['reviewPreferences: |', '  Yaml-only review prefs.'].join('\n')
    )

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepoWithPromptPrefs({
      reviewPreferences: 'Override review prefs.'
    })
    const result = getEffectiveHooks(repo)

    expect(result?.reviewPreferences).toBe('Override review prefs.')
  })

  it('falls back to yaml reviewPreferences when persisted override is blank', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      ['reviewPreferences: |', '  Yaml review prefs.'].join('\n')
    )

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepoWithPromptPrefs({ reviewPreferences: '   ' })
    const result = getEffectiveHooks(repo)

    expect(result?.reviewPreferences).toBe('Yaml review prefs.')
  })

  it('lets the persisted createPrPreferences override the yaml value', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      ['createPrPreferences: |', '  Yaml-only PR prefs.'].join('\n')
    )

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepoWithPromptPrefs({
      createPrPreferences: 'Override PR prefs.'
    })
    const result = getEffectiveHooks(repo)

    expect(result?.createPrPreferences).toBe('Override PR prefs.')
  })

  it('returns hooks with only prompt preferences when nothing else is configured', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepoWithPromptPrefs({
      reviewPreferences: 'Persisted review prefs.',
      createPrPreferences: 'Persisted PR prefs.'
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {},
      reviewPreferences: 'Persisted review prefs.',
      createPrPreferences: 'Persisted PR prefs.'
    })
  })

  // Why: shared helper that lets the new prompt-preferences cases pass a
  // hookSettings shape without restating the full Repo. Mirrors the existing
  // makeRepoWithDbOverride helper.
  function makeRepoWithPromptPrefs(prefs: {
    reviewPreferences?: string
    createPrPreferences?: string
  }): Repo {
    return {
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings: {
        mode: 'auto',
        scripts: { setup: '', archive: '' },
        ...prefs
      }
    } as unknown as Repo
  }

  // Why: builder helper that lets databaseUrl tests pass a `hookSettings` shape
  // without restating the full Repo. Keeps the test bodies focused on the
  // yaml/override merge semantics.
  function makeRepoWithDbOverride(databaseUrl: string): Repo {
    return {
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings: {
        mode: 'auto',
        scripts: { setup: '', archive: '' },
        databaseUrl
      }
    } as unknown as Repo
  }
})

describe('runHook', () => {
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
    scripts?: { setup: string; archive: string }
  }) =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings
    }) as unknown as Repo

  it('uses the Windows command shell when running hooks', async () => {
    execMock.mockImplementation((_script, _options, callback) => {
      callback?.(null, '', '')
      return {} as never
    })

    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    const originalComSpec = process.env.ComSpec

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', 'C:\\repo\\worktree', makeRepo())

      expect(result).toEqual({ success: true, output: '' })
      expect(execMock).toHaveBeenCalledWith(
        'echo hello',
        expect.objectContaining({
          cwd: 'C:\\repo\\worktree',
          shell: 'C:\\Windows\\System32\\cmd.exe'
        }),
        expect.any(Function)
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('keeps bash as the hook shell on non-Windows platforms', async () => {
    execMock.mockImplementation((_script, _options, callback) => {
      callback?.(null, '', '')
      return {} as never
    })

    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })
    process.env.SHELL = '/opt/homebrew/bin/fish'

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', '/repo/worktree', makeRepo())

      expect(result).toEqual({ success: true, output: '' })
      expect(execMock).toHaveBeenCalledWith(
        'echo hello',
        expect.objectContaining({
          cwd: '/repo/worktree',
          shell: '/bin/bash'
        }),
        expect.any(Function)
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('runs WSL hooks through wsl.exe and translates env paths to Linux', async () => {
    execMock.mockReset()
    execFileMock.mockReset()
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback?.(null, '', '')
      expect(options).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            ORCA_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            ORCA_WORKTREE_PATH: '/home/jin/feature',
            CONDUCTOR_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            GHOSTX_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca'
          })
        })
      )
      return {} as never
    })

    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\feature', {
        ...makeRepo(),
        path: 'C:\\Users\\jinwo\\git\\orca'
      })

      expect(result).toEqual({ success: true, output: '' })
      expect(execFileMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu', '--', 'bash', '-c', "cd '/home/jin/feature' && echo hello"],
        expect.any(Object),
        expect.any(Function)
      )
      expect(execMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})

describe('shouldRunSetupForCreate', () => {
  const makeRepo = (setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default') =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings: {
        mode: 'auto',
        setupRunPolicy,
        scripts: { setup: '', archive: '' }
      }
    }) as unknown as Repo

  it('requires an explicit decision when the repo policy is ask', async () => {
    const { shouldRunSetupForCreate } = await import('./hooks')

    expect(() => shouldRunSetupForCreate(makeRepo('ask'))).toThrow(
      'Setup decision required for this repository'
    )
  })

  it('uses the repo default when the caller inherits', async () => {
    const { shouldRunSetupForCreate } = await import('./hooks')

    expect(shouldRunSetupForCreate(makeRepo('run-by-default'))).toBe(true)
    expect(shouldRunSetupForCreate(makeRepo('skip-by-default'))).toBe(false)
  })

  it('lets the caller override the repo default per create', async () => {
    const { shouldRunSetupForCreate } = await import('./hooks')

    expect(shouldRunSetupForCreate(makeRepo('skip-by-default'), 'run')).toBe(true)
    expect(shouldRunSetupForCreate(makeRepo('run-by-default'), 'skip')).toBe(false)
  })
})
