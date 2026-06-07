/**
 * E2E: the "Make HTTP request" chain step. A focused render/interaction smoke
 * test (no live network Test — the harness has no controllable server). Proves
 * three things end-to-end against the running app: (a) the step is addable from
 * the chain editor and renders the shared HttpRequestEditor, (b) a connection
 * seeded into settings is threaded into the step's Connection picker, and
 * (c) Save is blocked while the freshly-added step is untested (the D7 gate).
 */
import { test, expect } from './helpers/orca-app'

test.describe('HTTP request step', () => {
  test('adds the step, threads a seeded connection, and blocks save until tested', async ({
    orcaPage
  }) => {
    const page = orcaPage

    // Open the Automations view via the app store (robust to sidebar state).
    await page.evaluate(() => {
      ;(window as unknown as { __store?: { getState(): { openAutomationsPage(): void } } }).__store
        ?.getState()
        .openAutomationsPage()
    })

    // Seed a connection into settings so the picker has a selectable option.
    // fetchSettings first: updateSettings early-returns when settings is null,
    // and the renderer may not have hydrated settings yet on a fresh profile.
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __store?: {
            getState(): {
              fetchSettings(): Promise<void>
              updateSettings(updates: unknown): Promise<void>
            }
          }
        }
      ).__store
      await store?.getState().fetchSettings()
      await store?.getState().updateSettings({
        httpConnections: [
          { id: 'c1', displayName: 'Acme API', baseUrl: 'https://api.acme.dev', headers: [] }
        ]
      })
    })

    // New automation → chain editor.
    await page.getByLabel('Add automation').click()
    const chainEditor = page.getByLabel('Edit automation chain')
    await expect(chainEditor).toBeVisible()

    // Add step → HTTP request (menuitem labeled by STEP_KIND_LABELS['http-request']).
    await page.getByLabel('Add step').click()
    await page.getByRole('menuitem', { name: 'HTTP request' }).click()

    // (a) The step card renders the shared HttpRequestEditor. A freshly-added
    // step has no connection, so the request input is labeled "URL" (it becomes
    // "Path" only once a connection is chosen).
    await expect(page.getByLabel('Connection')).toBeVisible()
    await expect(page.getByLabel('URL')).toBeVisible()
    // exact: true — the sortable step-card wrapper is also role="button" and its
    // accessible name substring-matches "Test"; only the real button is wanted.
    await expect(page.getByRole('button', { name: 'Test', exact: true })).toBeVisible()
    await expect(page.getByText('Headers', { exact: true })).toBeVisible()

    // (b) The settings-seeded connection is selectable in the picker — proves
    // httpConnections threads settings → AutomationsPage → ChainEditorModal.
    await expect(page.getByLabel('Connection')).toContainText('Acme API')

    // (c) Save gate: an untested http-request step keeps errors.length > 0, so
    // Save is disabled and the issue count reflects ≥1 issue (D7 gate).
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect(page.getByLabel('Issue count')).not.toHaveText('0 issues')

    await chainEditor.screenshot({ path: '/tmp/orca-http-request-step.png' })
  })
})
