import type { ModelUsage, Seat, Urgency } from '@crewdesk/core'

export type Placement = { kind: 'run'; seat: string; exclusive: boolean } | { kind: 'wait'; until: number }

export const quotaUnits = (usage: ModelUsage): number =>
  usage.inputTokens + usage.outputTokens + Math.round(usage.cachedTokens * 0.1)

export const windowIndex = (lengthMs: number, at: number): number => Math.floor(at / lengthMs)

export const quotaLeft = (seat: Seat, used: (lengthMs: number) => number): number =>
  seat.kind === 'metered'
    ? Number.POSITIVE_INFINITY
    : Math.min(...(seat.windows ?? []).map((window) => window.limit - used(window.lengthMs)))

export const quotaResetAt = (seat: Seat, used: (lengthMs: number) => number, now: number): number =>
  (seat.windows ?? [])
    .filter((window) => used(window.lengthMs) >= window.limit)
    .reduce(
      (latest, window) => Math.max(latest, (windowIndex(window.lengthMs, now) + 1) * window.lengthMs),
      now,
    )

export const placeTask = (
  urgency: Urgency,
  home: Seat,
  overflow: Seat,
  left: number,
  resetAt: number,
): Placement => {
  if (home.kind === 'metered') return { kind: 'run', seat: home.id, exclusive: false }
  if (left > 0) return { kind: 'run', seat: home.id, exclusive: true }
  if (urgency === 'high') return { kind: 'run', seat: overflow.id, exclusive: false }
  return { kind: 'wait', until: resetAt }
}
