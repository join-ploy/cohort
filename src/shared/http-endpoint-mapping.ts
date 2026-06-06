// src/shared/http-endpoint-mapping.ts
// Pure, IO-free mapping between an HTTP response and trigger variables.
// Shared by the renderer Test preview and the main-process poller.

import type { MappedField, MappedFieldType } from './automations-types'

export type ArrayCandidate = { path: string; length: number }

// Walk the body collecting every array, keyed by dot-path (''=top level),
// sorted largest-first so the editor can default to the most likely item list.
export function detectArrayPaths(body: unknown): ArrayCandidate[] {
  const out: ArrayCandidate[] = []
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      out.push({ path, length: node.length })
      return // Why: don't descend into array elements — element fields aren't item lists.
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, path ? `${path}.${k}` : k)
      }
    }
  }
  visit(body, '')
  return out.sort((a, b) => b.length - a.length)
}

export function resolveItems(body: unknown, itemsPath: string | null): unknown[] {
  if (itemsPath === null) {
    return body === undefined ? [] : [body]
  }
  const at = itemsPath === '' ? body : getByPath(body, itemsPath)
  return Array.isArray(at) ? at : []
}

// Resolve 'a.b[0].c' against a nested object. Returns undefined on any miss.
export function getByPath(root: unknown, path: string): unknown {
  if (path === '') {
    return root
  }
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1') // labels[0] -> labels.0
    .split('.')
    .filter((s) => s.length > 0)
  let cur: unknown = root
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

// Heuristic epoch boundary: values below this are treated as seconds, above as
// milliseconds. ~ Sat 2001-09-09 in seconds / 1973 in ms — safely splits the two.
const EPOCH_MS_THRESHOLD = 100_000_000_000

export function parseDateValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < EPOCH_MS_THRESHOLD ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? null : t
  }
  return null
}

export function inferFieldType(value: unknown): MappedFieldType {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'number') {
    return 'number'
  }
  if (typeof value === 'boolean') {
    return 'boolean'
  }
  if (typeof value === 'string') {
    return parseDateValue(value) !== null ? 'date' : 'string'
  }
  return 'unknown'
}

// Flat key from a path: trigger.http.<variableName> can't contain dots/brackets
// without nesting, so collapse them to underscores for the default name.
export function defaultVariableName(path: string): string {
  return path.replace(/\[(\d+)\]/g, '_$1').replace(/\./g, '_')
}

const MAX_FLATTEN_DEPTH = 6 // Why: bound pathological deeply-nested payloads.

export function flattenItem(item: unknown): MappedField[] {
  const out: MappedField[] = []
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_FLATTEN_DEPTH) {
      return
    }
    if (Array.isArray(node)) {
      node.forEach((el, i) => visit(el, `${path}[${i}]`, depth + 1))
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, path ? `${path}.${k}` : k, depth + 1)
      }
      return
    }
    // Leaf (primitive or null).
    if (path !== '') {
      out.push({
        path,
        variableName: defaultVariableName(path),
        enabled: true,
        type: inferFieldType(node),
        sampleValue: node
      })
    }
  }
  visit(item, '', 0)
  return out
}
