import type { ClockPort } from './ports.ts'

export const systemClock: ClockPort = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
