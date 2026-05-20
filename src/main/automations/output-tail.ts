/** Bounded ring buffer for PTY output capture.
 *
 *  Why: chain-engine `run-command` steps surface the tail of a command's
 *  output in their step output so downstream steps (and the run summary)
 *  have a debuggable window without pinning the entire stream in memory.
 *  PTYs emit a single merged stdout/stderr stream, so this captures one
 *  tail — not separate stdout/stderr tails.
 *
 *  Sizing is in UTF-16 code units (string `.length`), which approximates
 *  bytes for ASCII-heavy command output. Worst case the tail starts
 *  mid-codepoint, but the agent will still render it readably. */
export class OutputTail {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    if (!chunk) {
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
    // Evict oldest chunks while we're over the limit, keeping at least one
    // so a single oversized chunk can still be tail-truncated below.
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()
      if (removed) {
        this.size -= removed.length
      }
    }
    // If the only remaining chunk still exceeds the limit, truncate from the
    // left so the most-recent bytes survive.
    if (this.size > this.maxBytes && this.chunks.length === 1) {
      const remaining = this.maxBytes
      const last = this.chunks[0]
      this.chunks[0] = last.slice(last.length - remaining)
      this.size = remaining
    }
  }

  read(): string {
    return this.chunks.join('')
  }
}
