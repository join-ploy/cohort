import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TriggersModal } from './TriggersModal'
import type { TriggerConfig } from '../../../../../shared/automations-types'

const baseTrigger: TriggerConfig = { kind: 'manual' }

describe('TriggersModal', () => {
  it('does not render anything when closed', () => {
    const html = renderToStaticMarkup(
      <TriggersModal
        open={false}
        automationId=""
        trigger={baseTrigger}
        autoTriggers={[]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toBe('')
  })

  it('renders Manual section with the two checkboxes when open', () => {
    const html = renderToStaticMarkup(
      <TriggersModal
        open={true}
        automationId=""
        trigger={baseTrigger}
        autoTriggers={[]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('Accept Linear ticket on Run')
    expect(html).toContain('Pick project on Run')
  })

  it('renders Automatic section with Add dropdown', () => {
    const html = renderToStaticMarkup(
      <TriggersModal
        open={true}
        automationId=""
        trigger={baseTrigger}
        autoTriggers={[]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('Automatic')
    // Why: redesign replaced the literal "+ Add" string with an icon + label
    // button; assert on the new "Add trigger" label.
    expect(html).toContain('Add trigger')
    expect(html).toContain('No automatic triggers configured.')
  })

  it('renders the placeholder list when autoTriggers is non-empty', () => {
    const html = renderToStaticMarkup(
      <TriggersModal
        open={true}
        automationId="auto-1"
        trigger={baseTrigger}
        autoTriggers={[
          { id: 'at1', source: 'linear-issue', enabled: true, enabledAt: 0, rules: [] }
        ]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('auto trigger at1')
    expect(html).not.toContain('No automatic triggers configured.')
  })

  it('renders Cancel and Save buttons', () => {
    const html = renderToStaticMarkup(
      <TriggersModal
        open={true}
        automationId=""
        trigger={baseTrigger}
        autoTriggers={[]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('Cancel')
    expect(html).toContain('Save')
  })
})
