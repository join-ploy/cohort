import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TriggerPill, triggerLabel } from './TriggerPill'
import type { TriggerConfig, AutoTrigger } from '../../../../../shared/automations-types'

const baseTrigger: TriggerConfig = { kind: 'manual' }

describe('triggerLabel — auto-trigger awareness', () => {
  it('returns "Manual" when no auto triggers', () => {
    expect(triggerLabel(baseTrigger, [])).toBe('Manual')
    expect(triggerLabel(baseTrigger, undefined)).toBe('Manual')
  })

  it('preserves existing manual-flag labels when autoTriggers is empty', () => {
    expect(triggerLabel({ kind: 'manual', acceptsLinearTicket: true }, [])).toBe('Manual + Linear')
    expect(triggerLabel({ kind: 'manual', acceptsProjectSelection: true }, [])).toBe(
      'Manual + Project'
    )
    expect(
      triggerLabel({ kind: 'manual', acceptsLinearTicket: true, acceptsProjectSelection: true }, [])
    ).toBe('Manual (2 prompts)')
  })

  it('returns "Manual + Linear auto" with one enabled linear-issue trigger', () => {
    const triggers: AutoTrigger[] = [
      { id: 'at1', source: 'linear-issue', enabled: true, enabledAt: 0, rules: [] }
    ]
    expect(triggerLabel(baseTrigger, triggers)).toBe('Manual + Linear auto')
  })

  it('returns "Manual + N auto triggers" with multiple enabled triggers', () => {
    const triggers: AutoTrigger[] = [
      { id: 'at1', source: 'linear-issue', enabled: true, enabledAt: 0, rules: [] },
      { id: 'at2', source: 'linear-issue', enabled: true, enabledAt: 0, rules: [] }
    ]
    expect(triggerLabel(baseTrigger, triggers)).toBe('Manual + 2 auto triggers')
  })

  it('disabled triggers do not count', () => {
    const triggers: AutoTrigger[] = [
      { id: 'at1', source: 'linear-issue', enabled: false, enabledAt: 0, rules: [] }
    ]
    expect(triggerLabel(baseTrigger, triggers)).toBe('Manual')
  })

  it('combines manual-flag label with auto-trigger label', () => {
    const triggers: AutoTrigger[] = [
      { id: 'at1', source: 'linear-issue', enabled: true, enabledAt: 0, rules: [] }
    ]
    expect(triggerLabel({ kind: 'manual', acceptsLinearTicket: true }, triggers)).toBe(
      'Manual + Linear + Linear auto'
    )
  })
})

describe('TriggerPill rendering', () => {
  it('renders the computed label inside the trigger button', () => {
    const triggers: AutoTrigger[] = [
      { id: 'at1', source: 'linear-issue', enabled: true, enabledAt: 0, rules: [] }
    ]
    const html = renderToStaticMarkup(
      <TriggerPill trigger={baseTrigger} onOpenTriggers={() => {}} autoTriggers={triggers} />
    )
    expect(html).toContain('Manual + Linear auto')
  })

  it('renders as a plain button without an embedded popover/dialog', () => {
    // Why: Phase 11.2 — the pill no longer owns the popover; clicking it opens
    // the separate TriggersModal. So no role="dialog" inside this component.
    const html = renderToStaticMarkup(
      <TriggerPill trigger={baseTrigger} onOpenTriggers={() => {}} />
    )
    expect(html).toMatch(/<button[^>]*aria-label=["']Trigger["']/)
    expect(html).not.toMatch(/role=["']dialog["']/)
  })
})
