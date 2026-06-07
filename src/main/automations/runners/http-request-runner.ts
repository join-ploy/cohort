import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type {
  HttpConnection,
  HttpKeyValue,
  HttpRequestConfig,
  HttpRequestStepConfig
} from '../../../shared/automations-types'
import { resolveTemplate, TemplateResolutionError } from '../template'
import { mergeConnectionRequest } from '../http-connection-merge'
import { decryptHttpRequest } from '../http-endpoint-secrets'
import { executeHttpEndpointRequest, type HttpEndpointResponse } from '../http-endpoint-request'
import { resolveItems, mapItemToVariables } from '../../../shared/http-endpoint-mapping'

export type HttpRequestRunnerDeps = {
  // Injectable for tests; defaults to the real executor. The request is fully
  // resolved + decrypted before it reaches here.
  execute?: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>
  // Resolve a referenced connection by id (sealed base URL + headers at rest).
  getConnection?: (id: string) => HttpConnection | undefined
}

type Tracker = {
  /** Once the request resolves (success or failure), the terminal outcome is
   *  recorded here so a re-tick from the scheduler doesn't re-fire the request.
   *  Mirrors the (runId, stepId) keying used by every other runner. */
  resolved: StepRunnerResult
}

export class HttpRequestRunner implements StepRunner {
  // Why: nested map keyed by (runId, stepId) so a step.id containing ':' can't
  // collide with another run's tracker (mirrors the other one-shot runners).
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: HttpRequestRunnerDeps = {}) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as HttpRequestStepConfig

    // Why: idempotent re-tick — return the cached terminal outcome rather than
    // re-issuing the HTTP request.
    const cached = this.trackers.get(ctx.runId)?.get(ctx.step.id)
    if (cached) {
      return cached.resolved
    }

    const execute = this.deps.execute ?? executeHttpEndpointRequest
    const getConnection = this.deps.getConnection ?? (() => undefined)

    // Why: only resolve templates in NON-secret fields — secret values are
    // ciphertext (no templates) and are left for decrypt, so we don't garble them.
    const resolveKv = (list: HttpKeyValue[]): HttpKeyValue[] =>
      list.map((kv) => (kv.secret ? kv : { ...kv, value: resolveTemplate(kv.value, ctx.context) }))

    let resolved: HttpRequestConfig
    try {
      resolved = {
        ...config.request,
        url: resolveTemplate(config.request.url, ctx.context),
        headers: resolveKv(config.request.headers),
        query: resolveKv(config.request.query),
        body:
          config.request.bodySecret || config.request.body === undefined
            ? config.request.body
            : resolveTemplate(config.request.body, ctx.context)
      }
    } catch (e) {
      // Template resolution errors can never succeed on retry — bad authoring or
      // missing context. Fail fast (and record) instead of looping forever.
      if (e instanceof TemplateResolutionError) {
        const result: StepRunnerResult = {
          outcome: 'failed',
          status: 'failed',
          error: e.message
        }
        this.recordResolved(ctx.runId, ctx.step.id, result)
        return result
      }
      throw e
    }

    // Why: merge the connection's base URL + headers BEFORE decrypt so a single
    // decrypt pass covers both the step's own and the connection's secrets
    // (no double-decrypt). mergeConnectionRequest is a no-op with no connection.
    const connection = config.connectionId ? getConnection(config.connectionId) : undefined
    const merged = mergeConnectionRequest(resolved, connection)
    const final = decryptHttpRequest(merged)

    let res: HttpEndpointResponse
    try {
      res = await execute(final)
    } catch (e) {
      const result: StepRunnerResult = {
        outcome: 'failed',
        status: 'failed',
        error: `http-request: ${e instanceof Error ? e.message : String(e)}`
      }
      this.recordResolved(ctx.runId, ctx.step.id, result)
      return result
    }

    if (res.status < 200 || res.status >= 300) {
      const result: StepRunnerResult = {
        outcome: 'failed',
        status: 'failed',
        error: `http-request: HTTP ${res.status}`
      }
      this.recordResolved(ctx.runId, ctx.step.id, result)
      return result
    }

    // Why: a step produces a single result (first item, or the whole body when
    // itemsPath is null) — no fan-out, unlike the poller trigger.
    const items = resolveItems(res.body, config.itemsPath)
    const item = items[0] ?? res.body
    const vars = mapItemToVariables(item, config.fields)
    const result: StepRunnerResult = {
      outcome: 'done',
      status: 'succeeded',
      output: vars,
      contextPatch: { steps: { [ctx.step.id]: vars } }
    }
    this.recordResolved(ctx.runId, ctx.step.id, result)
    return result
  }

  private recordResolved(runId: string, stepId: string, result: StepRunnerResult): void {
    let runTrackers = this.trackers.get(runId)
    if (!runTrackers) {
      runTrackers = new Map()
      this.trackers.set(runId, runTrackers)
    }
    runTrackers.set(stepId, { resolved: result })
  }

  dropRun(runId: string): void {
    this.trackers.delete(runId)
  }

  dropStep(runId: string, stepId: string): void {
    const runTrackers = this.trackers.get(runId)
    if (!runTrackers) {
      return
    }
    runTrackers.delete(stepId)
    if (runTrackers.size === 0) {
      this.trackers.delete(runId)
    }
  }
}
