import * as React from 'react'
import type {
  HttpConnection,
  HttpRequestConfig,
  HttpRequestStepConfig,
  Step,
  StepConfig
} from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { StepCardChrome } from './StepCardChrome'
import { HttpRequestEditor } from './HttpRequestEditor'

export type HttpRequestStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  httpConnections: HttpConnection[]
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: HttpRequestStepConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

/**
 * Body for a `make HTTP request` step: the shared HttpRequestEditor (connection
 * picker + request builder + Test + field mapping) over the step's config.
 */
export function HttpRequestStepCard(props: HttpRequestStepCardProps): React.JSX.Element {
  const config = props.step.config as HttpRequestStepConfig
  // Why: a step has no autoTriggerId, so its Test resolves connection secrets via
  // connectionId (and fresh-typed inline secrets pass through); it can't resolve a
  // previously-saved inline step secret — connections are the reusable-secret path.
  const onTest = (args: {
    request: HttpRequestConfig
    connectionId?: string
  }): Promise<{ status: number; durationMs: number; body: unknown }> =>
    window.api.httpEndpoint.test({ request: args.request, connectionId: args.connectionId })

  return (
    <StepCardChrome
      step={props.step}
      stepIndex={props.stepIndex}
      available={props.available}
      disableDrag={props.disableDrag}
      onIdChange={props.onIdChange}
      onConfigChange={props.onConfigChange as (config: StepConfig) => void}
      onOnFailureChange={props.onOnFailureChange}
      onTimeoutChange={props.onTimeoutChange}
      onDelete={props.onDelete}
    >
      <HttpRequestEditor
        value={config}
        onChange={props.onConfigChange}
        httpConnections={props.httpConnections}
        available={props.available}
        onTest={onTest}
      />
    </StepCardChrome>
  )
}
