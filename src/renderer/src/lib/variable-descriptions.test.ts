import { describe, it, expect } from 'vitest'
import { buildPaths, type PathEntry } from './available-variables-tree'
import { describeVariable } from './variable-descriptions'
import type { AvailableVariables } from './template-dry-run'
import {
  GITHUB_PR_TRIGGER_OVERLAY,
  getOutputSchemaForKind,
  LINEAR_TICKET_TRIGGER_OVERLAY,
  MANUAL_TRIGGER_SCHEMA,
  type NestedSchema
} from '../../../shared/automation-step-schemas'
import type { StepKind } from '../../../shared/automations-types'

// Every StepKind, so the completeness guard covers each kind's output leaves.
const ALL_KINDS: StepKind[] = [
  'create-worktree',
  'create-workspace-group',
  'wait-for-setup',
  'run-prompt',
  'run-command',
  'update-linear-issue',
  'collect-ci-results',
  'watch-pr'
]

// An AvailableVariables that exercises every namespace, the Linear trigger
// overlay, a group with a member, and every step kind — so buildPaths emits one
// entry for each describable variable in the product.
function everyVariable(): AvailableVariables {
  const steps: AvailableVariables['steps'] = {}
  const stepKinds: Record<string, StepKind> = {}
  for (const kind of ALL_KINDS) {
    steps[kind] = getOutputSchemaForKind(kind)
    stepKinds[kind] = kind
  }
  const trigger: NestedSchema = {
    ...MANUAL_TRIGGER_SCHEMA,
    linear: LINEAR_TICKET_TRIGGER_OVERLAY.linear,
    github: GITHUB_PR_TRIGGER_OVERLAY.github
  }
  return {
    automation: { projectId: 'string', workspaceId: 'string' },
    trigger,
    steps,
    stepKinds,
    group: {
      id: 'string',
      parentPath: 'string',
      members: {
        orca: {
          worktreeId: 'string',
          path: 'string',
          repoId: 'string',
          scoped: 'string',
          description: 'string'
        }
      }
    }
  }
}

describe('describeVariable', () => {
  it('returns a non-empty description for every variable in every namespace', () => {
    const paths = buildPaths(everyVariable())
    const missing = paths
      .filter((e) => {
        const d = describeVariable(e)
        return !d || d.trim().length === 0
      })
      .map((e) => e.path)
    expect(missing).toEqual([])
  })

  it('gives kind-specific copy for a leaf shared across step kinds', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: {},
      steps: { rp: { outputTail: 'string' }, rc: { outputTail: 'string' } },
      stepKinds: { rp: 'run-prompt', rc: 'run-command' }
    }
    const paths = buildPaths(schema)
    const rp = describeVariable(byPath(paths, 'steps.rp.outputTail'))
    const rc = describeVariable(byPath(paths, 'steps.rc.outputTail'))
    expect(rp).toBeTruthy()
    expect(rc).toBeTruthy()
    expect(rp).not.toBe(rc)
  })

  it('describes group member leaves by leaf name regardless of the folder segment', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: {},
      steps: {},
      group: {
        id: 'string',
        parentPath: 'string',
        members: { anything: { worktreeId: 'string' } }
      }
    }
    const paths = buildPaths(schema)
    expect(describeVariable(byPath(paths, 'group.members.anything.worktreeId'))).toBeTruthy()
  })

  it('returns undefined for an unknown path', () => {
    const entry: PathEntry = {
      namespace: 'automation',
      path: 'automation.bogus',
      leaf: 'bogus',
      type: 'string'
    }
    expect(describeVariable(entry)).toBeUndefined()
  })

  it('returns undefined for a step entry with no kind', () => {
    const entry: PathEntry = {
      namespace: 'steps',
      stepId: 'x',
      path: 'steps.x.worktreeId',
      leaf: 'worktreeId',
      type: 'string'
    }
    expect(describeVariable(entry)).toBeUndefined()
  })
})

function byPath(paths: PathEntry[], path: string): PathEntry {
  const entry = paths.find((p) => p.path === path)
  if (!entry) {
    throw new Error(`no entry for ${path}`)
  }
  return entry
}
