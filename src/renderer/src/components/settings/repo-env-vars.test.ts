import { describe, expect, it } from 'vitest'
import {
  envVarsEqual,
  envVarsToRows,
  isValidEnvVarName,
  rowsToEnvVars,
  type EnvVarRow
} from './repo-env-vars'

const seqId = (): (() => string) => {
  let n = 0
  return () => `id-${n++}`
}

describe('isValidEnvVarName', () => {
  it('accepts shell-portable names', () => {
    for (const k of ['FOO', 'FOO_BAR', '_X', 'a1', 'A_1_b']) {
      expect(isValidEnvVarName(k)).toBe(true)
    }
  })
  it('rejects names with bad first char or illegal chars', () => {
    for (const k of ['1FOO', 'FOO-BAR', 'FOO BAR', 'FOO.BAR', '', 'FÖÖ']) {
      expect(isValidEnvVarName(k)).toBe(false)
    }
  })
})

describe('rowsToEnvVars', () => {
  it('trims keys, drops empty/invalid keys, keeps values verbatim', () => {
    const rows: EnvVarRow[] = [
      { id: 'a', key: '  FOO ', value: 'bar ' },
      { id: 'b', key: '', value: 'ignored' },
      { id: 'c', key: '1BAD', value: 'ignored' },
      { id: 'd', key: 'OK', value: '' }
    ]
    expect(rowsToEnvVars(rows)).toEqual({ FOO: 'bar ', OK: '' })
  })
  it('last valid row wins on duplicate keys', () => {
    const rows: EnvVarRow[] = [
      { id: 'a', key: 'FOO', value: 'first' },
      { id: 'b', key: 'FOO', value: 'second' }
    ]
    expect(rowsToEnvVars(rows)).toEqual({ FOO: 'second' })
  })
})

describe('envVarsToRows', () => {
  it('round-trips and preserves insertion order with injected ids', () => {
    const rows = envVarsToRows({ B: '2', A: '1' }, seqId())
    expect(rows).toEqual([
      { id: 'id-0', key: 'B', value: '2' },
      { id: 'id-1', key: 'A', value: '1' }
    ])
    expect(rowsToEnvVars(rows)).toEqual({ B: '2', A: '1' })
  })
})

describe('envVarsEqual', () => {
  it('is true for same entries regardless of key order', () => {
    expect(envVarsEqual({ A: '1', B: '2' }, { B: '2', A: '1' })).toBe(true)
  })
  it('is false when a value or key differs', () => {
    expect(envVarsEqual({ A: '1' }, { A: '2' })).toBe(false)
    expect(envVarsEqual({ A: '1' }, { A: '1', B: '2' })).toBe(false)
  })
})
