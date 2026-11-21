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
  { system: 'iam', resource: 'accounts', field: 'org_cd', prefix: '' },
  { system: 'deployer', resource: 'services', field: 'owner', prefix: '' },
  { system: 'incident', resource: 'groups', field: 'org_cd', prefix: '' },
  { system: 'incident', resource: 'groups', field: 'grp', prefix: 'G-' },
]

const rename = (
  systems: MemorySystems,
  target: { system: string; resource: string; field: string },
  from: string,
  to: string,
) =>
  systems.mutate(target.system, 'codeChange', { ...target, from, to }, (db) =>
    renameCode(db, target, from, to),
  )

export const applyEvent = (systems: MemorySystems, event: SimEvent): void => {
  if (event.kind === 'codeChange') {
    const { system, resource, field, from, to } = event
    rename(systems, { system, resource, field }, from, to)
  }
  if (event.kind === 'reorg') {
    for (const { prefix, ...target } of orgColumns) {
      rename(systems, target, prefix + event.from, prefix + event.to)
    }
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
