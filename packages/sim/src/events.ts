import { renameCode } from './company/actions.ts'
import type { MemorySystems } from './dummies/systems.ts'

export type SimEvent =
  | {
      at: number
      kind: 'codeChange'
      system: string
      resource: string
      field: string
      from: string
      to: string
    }
  | { at: number; kind: 'reorg'; from: string; to: string }
  | { at: number; kind: 'burst'; durationMs: number; factor: number }
  | { at: number; kind: 'runtimeOutage'; durationMs: number; failureRate: number }
  | { at: number; kind: 'seatDrain'; seat: string; units: number }

const orgColumns = [
  { system: 'iam', resource: 'accounts', field: 'org_cd' },
  { system: 'deployer', resource: 'services', field: 'owner' },
  { system: 'incident', resource: 'groups', field: 'org_cd' },
]

export const applyEvent = (systems: MemorySystems, event: SimEvent): void => {
  if (event.kind === 'codeChange') {
    const { at: _, kind, from, to, ...target } = event
    systems.mutate(event.system, kind, { ...target, from, to }, (db) => renameCode(db, target, from, to))
  }
  if (event.kind === 'reorg') {
    const { from, to } = event
    systems.mutate('iam', 'reorg', { from, to }, (db) =>
      renameCode(
        orgColumns.reduce((next, column) => renameCode(next, column, from, to), db),
        { system: 'incident', resource: 'groups', field: 'grp' },
        `G-${from}`,
        `G-${to}`,
      ),
    )
  }
}

export const failureRateAt = (events: SimEvent[], now: number, base: number): number =>
  events.reduce(
    (rate, event) =>
      event.kind === 'runtimeOutage' && now >= event.at && now < event.at + event.durationMs
        ? Math.max(rate, event.failureRate)
        : rate,
    base,
  )
