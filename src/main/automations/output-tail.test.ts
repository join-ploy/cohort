import { describe, it, expect } from 'vitest'
import { OutputTail } from './output-tail'

describe('OutputTail', () => {
  it('returns an empty string when nothing has been appended', () => {
    const tail = new OutputTail(1024)
    expect(tail.read()).toBe('')
  })

  it('preserves all data when total size stays under the limit', () => {
    const tail = new OutputTail(1024)
    tail.append('hello ')
    tail.append('world\n')
    expect(tail.read()).toBe('hello world\n')
  })

  it('evicts old data once the buffer exceeds maxBytes', () => {
    const tail = new OutputTail(10)
    // Append chunks summing well past maxBytes; only the latest tail survives.
    tail.append('aaaaa') // 5
    tail.append('bbbbb') // 10 (still under or equal)
    tail.append('ccccc') // 15 → evict first chunk → 10
    tail.append('ddddd') // 15 → evict next chunk → 10
    const result = tail.read()
    expect(result.length).toBeLessThanOrEqual(10)
    expect(result).toBe('cccccddddd')
  })

  it('does not truncate when the running total matches maxBytes exactly', () => {
    const tail = new OutputTail(10)
    tail.append('1234567890') // exactly 10
    expect(tail.read()).toBe('1234567890')
    expect(tail.read().length).toBe(10)
  })

  it('treats empty / falsy chunks as a no-op', () => {
    const tail = new OutputTail(64)
    tail.append('')
    tail.append('hello')
    tail.append('')
    expect(tail.read()).toBe('hello')
  })

  it('truncates a single oversized chunk from the left so the latest bytes survive', () => {
    const tail = new OutputTail(8)
    tail.append('0123456789ABCDEF') // 16 bytes into an 8-byte tail
    expect(tail.read()).toBe('89ABCDEF')
    expect(tail.read().length).toBe(8)
  })
})
