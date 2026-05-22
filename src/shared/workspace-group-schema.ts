/* Why: workspaceGroups are read back from orca-data.json on startup; a type
 * flip in a future build (or a truncated write) shouldn't poison Zustand
 * state. Schema-validate at the read boundary and drop malformed entries
 * silently rather than throwing into main. Same pattern as
 * workspace-session-schema.ts. */
import { z } from 'zod'
import type { WorkspaceGroup } from './types'

const workspaceGroupSchema = z
  .object({
    id: z.string(),
    workspaceName: z.string(),
    displayName: z.string(),
    parentPath: z.string(),
    memberWorktreeIds: z.array(z.string()),
    branchName: z.string(),
    isArchived: z.boolean(),
    archivedAt: z.number().nullable(),
    archiveCleanupError: z.string().nullable().optional(),
    isPinned: z.boolean(),
    sortOrder: z.number(),
    lastActivityAt: z.number(),
    isUnread: z.boolean(),
    comment: z.string(),
    createdAt: z.number(),
    createdByAutomationRunId: z.string().optional(),
    linkedIssue: z.number().nullable(),
    linkedLinearIssue: z.string().nullable()
  })
  .passthrough()

export function parseWorkspaceGroups(raw: unknown): WorkspaceGroup[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: WorkspaceGroup[] = []
  for (const entry of raw) {
    const parsed = workspaceGroupSchema.safeParse(entry)
    if (parsed.success) {
      out.push(parsed.data as WorkspaceGroup)
    }
  }
  return out
}
