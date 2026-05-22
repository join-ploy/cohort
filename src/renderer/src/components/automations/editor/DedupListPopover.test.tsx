import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DedupListPopover } from './DedupListPopover'
import type { AutoDedupEntry } from '../../../../../shared/automations-types'

const mkEntry = (overrides: Partial<AutoDedupEntry> = {}): AutoDedupEntry => ({
  automationId: 'auto-1',
  autoTriggerId: 'at-1',
  sourceId: 'linear-issue',
  entityId: 'issue-1',
  entityIdentifier: 'ORC-123',
  firedAt: 1700000000000,
  ...overrides
})

describe('DedupListPopover', () => {
  it('renders nothing when open is false', () => {
    const html = renderToStaticMarkup(
      <DedupListPopover
        entries={[]}
        open={false}
        onClearOne={() => {}}
        onClearAll={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toBe('')
  })

  it('renders "Fired for N issues" header with N from entries', () => {
    const html = renderToStaticMarkup(
      <DedupListPopover
        entries={[mkEntry(), mkEntry({ entityId: 'issue-2', entityIdentifier: 'ORC-124' })]}
        open={true}
        onClearOne={() => {}}
        onClearAll={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('Fired for 2 issues')
  })

  it('renders empty state when entries is empty', () => {
    const html = renderToStaticMarkup(
      <DedupListPopover
        entries={[]}
        open={true}
        onClearOne={() => {}}
        onClearAll={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('No fired issues recorded.')
  })

  it('renders one <li> per entry with identifier, timestamp, and per-row Clear button', () => {
    const entry = mkEntry({ entityIdentifier: 'ORC-7', firedAt: 1700000000000 })
    const html = renderToStaticMarkup(
      <DedupListPopover
        entries={[entry]}
        open={true}
        onClearOne={() => {}}
        onClearAll={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('ORC-7')
    expect(html).toContain(new Date(1700000000000).toLocaleString())
    expect(html).toMatch(/aria-label="Clear ORC-7"/i)
  })

  it('falls back to entityId when entityIdentifier is undefined', () => {
    const entry = mkEntry({ entityIdentifier: undefined, entityId: 'raw-id-7' })
    const html = renderToStaticMarkup(
      <DedupListPopover
        entries={[entry]}
        open={true}
        onClearOne={() => {}}
        onClearAll={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('raw-id-7')
    expect(html).toMatch(/aria-label="Clear raw-id-7"/i)
  })

  it('disables Clear all when entries is empty', () => {
    const html = renderToStaticMarkup(
      <DedupListPopover
        entries={[]}
        open={true}
        onClearOne={() => {}}
        onClearAll={() => {}}
        onClose={() => {}}
      />
    )
    // Match the standalone HTML `disabled` boolean attr (not the Tailwind
    // `disabled:opacity-50` class) in the same tag as the "Clear all" text.
    expect(/Clear all<\/button>/i.test(html)).toBe(true)
    expect(/\sdisabled(=""|\s|>)[^>]*>Clear all/i.test(html)).toBe(true)
  })

  it('enables Clear all when entries are present', () => {
    const html = renderToStaticMarkup(
      <DedupListPopover
        entries={[mkEntry()]}
        open={true}
        onClearOne={() => {}}
        onClearAll={() => {}}
        onClose={() => {}}
      />
    )
    expect(/\sdisabled(=""|\s|>)[^>]*>Clear all/i.test(html)).toBe(false)
  })
})
