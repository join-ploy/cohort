// Why: shared between the cleanup service (main) and the Archived view's
// countdown (renderer); one override point keeps both halves and tests in sync.
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const ARCHIVE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
