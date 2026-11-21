import type { ClockPort } from '@crewdesk/core'

type Timer = { at: number; seq: number; wake(): void }

export type VirtualClock = ClockPort & { runUntil(end: number): Promise<void> }

const settleMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve))

export const createVirtualClock = (start = 0): VirtualClock => {
  let now = start
  let seq = 0
  let timers: Timer[] = []

  const earliest = () =>
    timers.reduce<Timer | undefined>(
      (best, timer) =>
        !best || timer.at < best.at || (timer.at === best.at && timer.seq < best.seq) ? timer : best,
      undefined,
    )

  return {
    now: () => now,
    sleep: (ms) =>
      new Promise<void>((wake) => {
        timers = [...timers, { at: now + Math.max(0, ms), seq: seq++, wake }]
      }),
    runUntil: async (end) => {
      for (;;) {
        await settleMicrotasks()
        const next = earliest()
        if (!next || next.at > end) break
        timers = timers.filter((timer) => timer !== next)
        now = next.at
        next.wake()
      }
      if (Number.isFinite(end)) now = Math.max(now, end)
    },
  }
}
