// src/shared/http-endpoint-mapping.ts
// Pure, IO-free mapping between an HTTP response and trigger variables.
// Shared by the renderer Test preview and the main-process poller.

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
