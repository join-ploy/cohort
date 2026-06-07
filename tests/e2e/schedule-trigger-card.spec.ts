/**
 * E2E: the Schedule trigger editor card drives its visual recurrence builder in
 * the running app. Mirrors http-trigger-card.spec.ts — open the Automations view,
 * open the Triggers modal, add a Schedule trigger — then exercises the daily
 * default + live preview, the Advanced raw-cron invalid→valid flow, and the
 * Weekly weekday chips. The "Next runs" preview is date-dependent, so it's
 * asserted by presence (visible + non-empty rows), never by exact future dates;
 * only stable strings (the cron value, the error text, control labels) are
 * matched exactly.
 */
import { test, expect } from './helpers/orca-app'

test.describe('Schedule trigger card', () => {
  test('recurrence builder, cron validation, and weekday chips', async ({ orcaPage }) => {
    const page = orcaPage

    // Open the Automations view via the app store (robust to sidebar state).
    await page.evaluate(() => {
      ;(window as unknown as { __store?: { getState(): { openAutomationsPage(): void } } }).__store
        ?.getState()
        .openAutomationsPage()
    })

    // New automation → chain editor → triggers modal → add a Schedule trigger.
    await page.getByLabel('Add automation').click()
    await expect(page.getByLabel('Edit automation chain')).toBeVisible()
    await page.getByLabel('Trigger', { exact: true }).click()
    const triggersDialog = page.getByRole('dialog', { name: 'Triggers' })
    await expect(triggersDialog).toBeVisible()
    await page.getByLabel('Add automatic trigger').click()
    await page.getByRole('menuitem', { name: 'Schedule' }).click()

    // The card renders with the seeded daily-09:00 default builder.
    const card = page.locator('[aria-label^="auto trigger"]')
    await expect(card).toBeVisible()
    const repeat = card.getByLabel('Repeat')
    await expect(repeat).toHaveValue('daily')

    // The "Next runs" preview is present and non-empty for the valid default.
    const nextRunsLabel = card.getByText('Next runs', { exact: true })
    const previewRows = card.getByRole('listitem')
    await expect(nextRunsLabel).toBeVisible()
    await expect(previewRows.first()).not.toBeEmpty()

    // Advanced → the raw cron field exposes the seeded daily default. Checked
    // before switching Repeat so the exact default `0 9 * * *` is deterministic.
    await card.getByRole('button', { name: 'Advanced' }).click()
    const cron = card.getByLabel('Cron expression')
    await expect(cron).toHaveValue('0 9 * * *')

    // An invalid cron surfaces the inline error and suppresses the preview.
    const cronError = card.getByText('Enter a valid 5-field cron expression.')
    await cron.fill('not a cron')
    await expect(cronError).toBeVisible()
    await expect(nextRunsLabel).toBeHidden()
    await expect(previewRows).toHaveCount(0)

    // Restoring a valid cron clears the error and brings the preview back.
    await cron.fill('0 9 * * *')
    await expect(cronError).toBeHidden()
    await expect(nextRunsLabel).toBeVisible()
    await expect(previewRows.first()).not.toBeEmpty()

    // Switching Repeat to Weekly reveals the weekday chips; preview stays live.
    await repeat.selectOption('weekly')
    await expect(card.getByText('On days', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Monday' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Friday' })).toBeVisible()
    await expect(nextRunsLabel).toBeVisible()
    await expect(previewRows.first()).not.toBeEmpty()
  })
})
