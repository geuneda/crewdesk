import type { ChangeEvent, ClockPort, DomainError, DomainSystemPort, Json, JsonObject } from '@crewdesk/core'

export type Db = Record<string, Record<string, JsonObject[]>>

export type ActionOutcome =
  | { ok: true; value: Json; db: Db; change: { kind: string; detail: JsonObject } }
  | { ok: false; error: DomainError }

export type ActionHandler = (db: Db, params: JsonObject) => ActionOutcome

export type MemorySystems = DomainSystemPort & {
  snapshot(): Db
  mutate(system: string, kind: string, detail: JsonObject, change: (db: Db) => Db): void
}

export const createMemorySystems = (options: {
  db: Db
  actions: Record<string, Record<string, ActionHandler>>
  clock: ClockPort
}): MemorySystems => {
  let db = options.db
  let events: ChangeEvent[] = []

  const record = (system: string, kind: string, detail: JsonObject) => {
    events = [...events, { seq: events.length + 1, at: options.clock.now(), system, kind, detail }]
  }

  return {
    snapshot: () => db,
    mutate: (system, kind, detail, change) => {
      db = change(db)
      record(system, kind, detail)
    },
    query: async ({ system, resource, where = {} }) => {
      const rows = db[system]?.[resource]
      if (!rows) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `no resource ${system}/${resource}` } }
      }
      const filters = Object.entries(where)
      return { ok: true, value: rows.filter((row) => filters.every(([key, value]) => row[key] === value)) }
    },
    execute: async ({ system, action, params }) => {
      const handler = options.actions[system]?.[action]
      if (!handler) {
        return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `no action ${system}/${action}` } }
      }
      const outcome = handler(db, params)
      if (!outcome.ok) return outcome
      db = outcome.db
      record(system, outcome.change.kind, outcome.change.detail)
      return { ok: true, value: outcome.value }
    },
    changes: async (sinceSeq) => events.filter((event) => event.seq > sinceSeq),
  }
}
