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
        availableSources={[{ id: 'linear-issue', label: 'Linear issue' }]}
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
        availableSources={[{ id: 'linear-issue', label: 'Linear issue' }]}
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
        availableSources={[{ id: 'linear-issue', label: 'Linear issue' }]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('Automatic')
    expect(html).toContain('+ Add')
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
        availableSources={[{ id: 'linear-issue', label: 'Linear issue' }]}
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
        availableSources={[]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('Cancel')
    expect(html).toContain('Save')
  })
})
