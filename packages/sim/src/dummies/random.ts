import type { RandomPort } from '@crewdesk/core'

export const createSeededRandom = (seed: number): RandomPort => {
  let state = seed >>> 0
  return {
    next: () => {
      state = (state + 0x6d2b79f5) >>> 0
      const a = Math.imul(state ^ (state >>> 15), state | 1)
      const b = a ^ (a + Math.imul(a ^ (a >>> 7), a | 61))
      return ((b ^ (b >>> 14)) >>> 0) / 4294967296
    },
  }
}
