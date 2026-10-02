import { describe, expect, it } from 'vitest'
import { addressesMatch } from './ownership'

describe('addressesMatch', () => {
  it('recomputes ownership from the current wallet account', () => {
    const owner = '0xAbCd000000000000000000000000000000001234'
    expect(addressesMatch(owner, owner.toLowerCase())).toBe(true)
    expect(addressesMatch(owner, '0x0000000000000000000000000000000000000001')).toBe(false)
    expect(addressesMatch(owner, undefined)).toBe(false)
  })
})
