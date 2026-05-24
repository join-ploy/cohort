import { describe, it, expect } from 'vitest'
import { resolveGroupParentPath, memberWorktreePath } from './workspace-group-paths'

describe('group path helpers', () => {
  it('resolveGroupParentPath joins workspaces root + group name', () => {
    expect(resolveGroupParentPath('/u/m/orca/workspaces', 'daring_tiger')).toBe(
      '/u/m/orca/workspaces/daring_tiger'
    )
  })
  it('memberWorktreePath puts repo subfolder under group parent', () => {
    expect(memberWorktreePath('/u/m/orca/workspaces', 'daring_tiger', 'ploy-client')).toBe(
      '/u/m/orca/workspaces/daring_tiger/ploy-client'
    )
  })
})
