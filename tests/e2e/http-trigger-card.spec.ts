/**
 * E2E: the HTTP-endpoint trigger editor card renders its section labels on their
 * own line above the adjacent control (dropdown / Add button), not collapsed onto
 * the same line. Verifies the inline-span → block-<p> spacing fix by measuring the
 * real laid-out geometry in the running app and capturing a screenshot.
 */
import { test, expect } from './helpers/orca-app'

test.describe('HTTP trigger card', () => {
  test('section labels sit above their controls (spacing fix)', async ({ orcaPage }) => {
    const page = orcaPage

    // Open the Automations view via the app store (robust to sidebar state).
    await page.evaluate(() => {
      ;(window as unknown as { __store?: { getState(): { openAutomationsPage(): void } } }).__store
        ?.getState()
        .openAutomationsPage()
    })

    // New automation → chain editor → triggers modal → add an HTTP endpoint trigger.
    await page.getByLabel('Add automation').click()
    await expect(page.getByLabel('Edit automation chain')).toBeVisible()
    await page.getByLabel('Trigger', { exact: true }).click()
    const triggersDialog = page.getByRole('dialog', { name: 'Triggers' })
    await expect(triggersDialog).toBeVisible()
    await page.getByLabel('Add automatic trigger').click()
    await page.getByRole('menuitem', { name: 'HTTP endpoint' }).click()

    // The card now renders. Headers/Query sections show their label + an Add button
    // even with no rows yet — the exact empty state where the inline label used to
    // collapse onto the button's line.
    const headersLabel = page.getByText('Headers', { exact: true })
    const addHeaderBtn = page.getByRole('button', { name: 'Add header' })
    await expect(headersLabel).toBeVisible()
    await expect(addHeaderBtn).toBeVisible()

    const labelBox = await headersLabel.boundingBox()
    const btnBox = await addHeaderBtn.boundingBox()
    expect(labelBox, 'headers label has a layout box').not.toBeNull()
    expect(btnBox, 'add-header button has a layout box').not.toBeNull()
    // The fix: the button's top is at/below the label's bottom (own line). Pre-fix
    // (inline span) the button shared the label's line → btn.y ≈ label.y.
    expect(btnBox!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height - 2)

    await triggersDialog.screenshot({ path: '/tmp/orca-http-trigger-card.png' })
  })
})
