import type { Seat, Stage } from '@crewdesk/core'
import type { Pricing, Route } from '@crewdesk/ops'
import { DAY, HOUR } from '../time.ts'

export const fakePricing: Pricing = {
  small: { inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 0.1 },
  medium: { inputPerMTok: 3, outputPerMTok: 15, cachedPerMTok: 0.3 },
  large: { inputPerMTok: 15, outputPerMTok: 75, cachedPerMTok: 1.5 },
}

const agents = ['access', 'deploy', 'incident']
const shared: Seat[] = [
  { id: 'seat-intake', agent: 'intake', kind: 'metered' },
  { id: 'seat-overflow', agent: 'overflow', kind: 'metered' },
]

export const quotaSeats = (windows: NonNullable<Seat['windows']>): Seat[] => [
  ...shared,
  ...agents.map((agent): Seat => ({ id: `seat-${agent}`, agent: `agent-${agent}`, kind: 'quota', windows })),
]

export const defaultSeats: Seat[] = quotaSeats([
  { lengthMs: 5 * HOUR, limit: 2_000_000 },
  { lengthMs: 7 * DAY, limit: 12_000_000 },
])

export const meteredSeats: Seat[] = [
  ...shared,
  ...agents.map((agent): Seat => ({ id: `seat-${agent}`, agent: `agent-${agent}`, kind: 'metered' })),
]

export const defaultRoutes: Route[] = [
  { stage: 'intake', model: 'small' },
  { stage: 'close', model: 'small' },
  { stage: 'work', risk: 'high', model: 'large' },
  { stage: 'work', model: 'medium' },
  { stage: 'batch', model: 'medium' },
  { stage: 'eval', model: 'medium' },
]

const stages: Stage[] = ['intake', 'work', 'close', 'batch', 'eval']

export const flatRoutes = (model: string): Route[] => stages.map((stage) => ({ stage, model }))
