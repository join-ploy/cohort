import { describe, expect, it } from 'vitest'
import { dirname, joinPath, tildifyPath } from './path'

describe('dirname', () => {
  it('keeps the POSIX root when resolving a file in the filesystem root', () => {
    expect(dirname('/README.md')).toBe('/')
  })

  it('keeps the POSIX root when given the root path directly', () => {
    expect(dirname('/')).toBe('/')
  })

  it('keeps the Windows drive root when resolving a file in the drive root', () => {
    expect(dirname('C:\\README.md')).toBe('C:')
  })
})

describe('joinPath', () => {
  it('joins onto a Windows drive root returned by dirname', () => {
    expect(joinPath(dirname('C:\\README.md'), 'image.png')).toBe('C:/image.png')
  })
})

describe('tildifyPath', () => {
  it('collapses the home prefix to ~', () => {
    expect(tildifyPath('/Users/hoyon/orca/workspaces/abc', '/Users/hoyon')).toBe(
      '~/orca/workspaces/abc'
    )
  })

  it('collapses a path equal to the home dir', () => {
    expect(tildifyPath('/Users/hoyon', '/Users/hoyon')).toBe('~')
  })

  it('leaves paths outside home untouched', () => {
    expect(tildifyPath('/var/tmp/abc', '/Users/hoyon')).toBe('/var/tmp/abc')
  })

  it('does not collapse a sibling whose name extends the home dir', () => {
    expect(tildifyPath('/Users/hoyonable/x', '/Users/hoyon')).toBe('/Users/hoyonable/x')
  })

  it('handles Windows separators after the home prefix', () => {
    expect(tildifyPath('C:\\Users\\hoyon\\orca', 'C:\\Users\\hoyon')).toBe('~\\orca')
  })

  it('returns the path unchanged when the home dir is empty', () => {
    expect(tildifyPath('/Users/hoyon/orca', '')).toBe('/Users/hoyon/orca')
  })
})
