import type { Seat, Stage } from '@crewdesk/core'
import type { Pricing, Route } from '@crewdesk/ops'

export const fakePricing: Pricing = {
  small: { inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 0.1 },
  medium: { inputPerMTok: 3, outputPerMTok: 15, cachedPerMTok: 0.3 },
  large: { inputPerMTok: 15, outputPerMTok: 75, cachedPerMTok: 1.5 },
}

export const withWindows = (seats: Seat[], windows: NonNullable<Seat['windows']>): Seat[] =>
  seats.map((seat) => (seat.kind === 'quota' ? { ...seat, windows } : seat))

export const asMetered = (seats: Seat[]): Seat[] =>
  seats.map(({ id, agent }): Seat => ({ id, agent, kind: 'metered' }))

const stages: Stage[] = ['intake', 'work', 'close', 'batch', 'eval']

export const flatRoutes = (model: string): Route[] => stages.map((stage) => ({ stage, model }))
