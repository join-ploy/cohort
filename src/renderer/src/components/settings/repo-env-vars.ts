export type EnvVarRow = { id: string; key: string; value: string }

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidEnvVarName(key: string): boolean {
  return ENV_VAR_NAME.test(key)
}

export function rowsToEnvVars(rows: EnvVarRow[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!isValidEnvVarName(key)) {
      continue
    }
    // Why: values are used verbatim by the shell — a trailing space may be
    // intentional, so trim keys only, never values.
    result[key] = row.value
  }
  return result
}

export function envVarsToRows(
  envVars: Record<string, string>,
  makeId: () => string = () => crypto.randomUUID()
): EnvVarRow[] {
  return Object.entries(envVars).map(([key, value]) => ({ id: makeId(), key, value }))
}

export function envVarsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) {
    return false
  }
  return aKeys.every((k) => b[k] === a[k])
}
