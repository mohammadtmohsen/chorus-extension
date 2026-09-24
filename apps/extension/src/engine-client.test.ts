import { describe, expect, it } from 'vitest'
import { describeRefusal } from './engine-client.js'

describe('describeRefusal', () => {
  it('keeps the engine reason, not only its verdict', () => {
    expect(
      describeRefusal({
        status: 'rejected',
        requestId: 'r1',
        code: 'failed',
        detail: 'No adapter registered for "claude"',
      })
    ).toBe('failed: No adapter registered for "claude"')
  })

  it('falls back to the code when the engine gave no reason', () => {
    expect(describeRefusal({ status: 'rejected', requestId: 'r1', code: 'unsupported-version' })).toBe(
      'unsupported-version'
    )
  })
})
