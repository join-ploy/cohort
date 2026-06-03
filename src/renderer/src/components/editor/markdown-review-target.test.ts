import { describe, expect, it } from 'vitest'
import { resolveReviewTargets } from './markdown-review-target'

const tabs = [
  { id: 'tab-a', title: 'claude', customTitle: null, defaultTitle: 'Terminal 1' },
  { id: 'tab-b', title: 'bash', customTitle: 'My Shell', defaultTitle: 'Terminal 2' }
]

describe('resolveReviewTargets', () => {
  it('returns one target per agent-hosting tab in the worktree', () => {
    const targets = resolveReviewTargets({
      tabs,
      agentStatusByPaneKey: {
        'tab-a:1': { terminalTitle: 'claude' },
        'tab-a:2': { terminalTitle: 'claude' } // second pane, same tab -> deduped
      }
    })
    expect(targets).toEqual([{ tabId: 'tab-a', label: 'claude' }])
  })

  it('prefers customTitle, then the tab title, then agent terminalTitle', () => {
    const targets = resolveReviewTargets({
      tabs,
      agentStatusByPaneKey: { 'tab-b:1': { terminalTitle: 'codex' } }
    })
    expect(targets).toEqual([{ tabId: 'tab-b', label: 'My Shell' }])
  })

  it('labels by the tab title rather than the generic agent terminalTitle', () => {
    const targets = resolveReviewTargets({
      tabs: [
        { id: 'tab-c', title: 'Fix login bug', customTitle: null, defaultTitle: 'Terminal 1' }
      ],
      agentStatusByPaneKey: { 'tab-c:1': { terminalTitle: 'Terminal 1' } }
    })
    expect(targets).toEqual([{ tabId: 'tab-c', label: 'Fix login bug' }])
  })

  it('ignores agent panes whose tab is not in the worktree', () => {
    const targets = resolveReviewTargets({
      tabs,
      agentStatusByPaneKey: { 'tab-zzz:1': { terminalTitle: 'ghost' } }
    })
    expect(targets).toEqual([])
  })
})
