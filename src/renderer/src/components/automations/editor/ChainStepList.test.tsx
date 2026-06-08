// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChainStepList, isPasteAllowed } from './ChainStepList'
import {
  STEP_KIND_ORDER,
  defaultConfigForKind,
  pickDefaultWorktreeRef
} from './chain-editor-modal-state'
import { serializeStepForClipboard } from '../../../lib/chain-editor-clipboard'
import type { Step, StepKind, StepOrGroup } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

// Why: sonner is jsdom-hostile (raf-driven animations); pasteStep only calls
// toast.success / toast.error fire-and-forget, so a no-op stub is safe.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

// The branch (nested) editor omits 'watch-pr'; the top-level offers everything.
const BRANCH_STEP_KINDS: StepKind[] = STEP_KIND_ORDER.filter((k) => k !== 'watch-pr')

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

function watchPrStep(): Step {
  return {
    id: 'watch-1',
    kind: 'watch-pr',
    config: defaultConfigForKind('watch-pr'),
    onFailure: 'halt',
    timeoutSeconds: null
  }
}

// run-prompt is in BRANCH_STEP_KINDS (run-command is renderable but not in the
// palette), so it's the right "allowed kind" to prove paste succeeds.
function runPromptStep(): Step {
  return {
    id: 'run-prompt-1',
    kind: 'run-prompt',
    config: defaultConfigForKind('run-prompt'),
    onFailure: 'halt',
    timeoutSeconds: null
  }
}

function stubClipboard(text: string): void {
  vi.stubGlobal('window', window)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { readClipboardText: vi.fn().mockResolvedValue(text) } }
  })
}

function renderList(
  availableStepKinds: StepKind[],
  onStepsChange: (next: StepOrGroup[]) => void
): void {
  render(
    <ChainStepList
      steps={[]}
      onStepsChange={onStepsChange}
      availableStepKinds={availableStepKinds}
      getAvailableAtIndex={() => EMPTY_AVAIL}
      repos={[]}
      reviewCommands={[]}
      createPrCommands={[]}
      httpConnections={[]}
      pickDefaultWorktreeRef={pickDefaultWorktreeRef}
      getDefaultConfigForKind={defaultConfigForKind}
    />
  )
}

// Radix ContextMenu opens on `contextmenu`; fireEvent.contextMenu is the
// documented way to drive it under jsdom (userEvent doesn't simulate it).
async function pasteViaAddStep(): Promise<void> {
  fireEvent.contextMenu(screen.getByLabelText('Add step'))
  const item = await screen.findByRole('menuitem', { name: /Paste node/i })
  fireEvent.click(item)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('isPasteAllowed', () => {
  it('rejects a kind not in the available list (branch omits watch-pr)', () => {
    expect(isPasteAllowed('watch-pr', BRANCH_STEP_KINDS)).toBe(false)
  })

  it('allows a kind present in the available list', () => {
    expect(isPasteAllowed('run-prompt', BRANCH_STEP_KINDS)).toBe(true)
    expect(isPasteAllowed('watch-pr', STEP_KIND_ORDER)).toBe(true)
  })
})

describe('ChainStepList paste guard', () => {
  it('does NOT add a pasted watch-pr in a branch (availableStepKinds without watch-pr)', async () => {
    stubClipboard(serializeStepForClipboard(watchPrStep()))
    const onStepsChange = vi.fn()
    renderList(BRANCH_STEP_KINDS, onStepsChange)
    await pasteViaAddStep()
    // The guard rejects before mutating, so the owner is never notified.
    await waitFor(() => expect(window.api.ui.readClipboardText).toHaveBeenCalled())
    expect(onStepsChange).not.toHaveBeenCalled()
  })

  it('DOES add a pasted run-prompt in a branch (an allowed kind)', async () => {
    stubClipboard(serializeStepForClipboard(runPromptStep()))
    const onStepsChange = vi.fn()
    renderList(BRANCH_STEP_KINDS, onStepsChange)
    await pasteViaAddStep()
    await waitFor(() => expect(onStepsChange).toHaveBeenCalledTimes(1))
    const next = onStepsChange.mock.calls[0][0] as StepOrGroup[]
    expect(next).toHaveLength(1)
    expect((next[0] as Step).kind).toBe('run-prompt')
  })

  it('DOES add a pasted watch-pr at the top level (full availableStepKinds)', async () => {
    stubClipboard(serializeStepForClipboard(watchPrStep()))
    const onStepsChange = vi.fn()
    renderList(STEP_KIND_ORDER, onStepsChange)
    await pasteViaAddStep()
    await waitFor(() => expect(onStepsChange).toHaveBeenCalledTimes(1))
    const next = onStepsChange.mock.calls[0][0] as StepOrGroup[]
    expect(next).toHaveLength(1)
    expect((next[0] as Step).kind).toBe('watch-pr')
  })
})
