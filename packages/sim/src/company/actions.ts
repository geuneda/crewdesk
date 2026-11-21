import type { DomainError, JsonObject } from '@crewdesk/core'
import type { ActionHandler, ActionOutcome, Db } from '../dummies/systems.ts'

const rows = (db: Db, system: string, resource: string) => db[system]?.[resource] ?? []

const withRows = (db: Db, system: string, resource: string, next: JsonObject[]): Db => ({
  ...db,
  [system]: { ...db[system], [resource]: next },
})

const fail = (code: string, message: string, detail?: JsonObject): ActionOutcome => ({
  ok: false,
  error: { code, message, ...(detail ? { detail } : {}) } as DomainError,
})

const has = (list: JsonObject[], match: JsonObject) =>
  list.some((row) => Object.entries(match).every(([key, value]) => row[key] === value))

const unknownCode = (system: string, resource: string, field: string, value: unknown) =>
  fail('UNKNOWN_CODE', `${system} does not know ${field}=${String(value)}`, {
    system,
    resource,
    field,
    value: String(value),
  })

const add = (db: Db, system: string, resource: string, row: JsonObject, kind: string): ActionOutcome => ({
  ok: true,
  value: row,
  db: has(rows(db, system, resource), row)
    ? db
    : withRows(db, system, resource, [...rows(db, system, resource), row]),
  change: { kind, detail: row },
})

const grant: ActionHandler = (db, { uid, sys, role_cd }) => {
  if (!has(rows(db, 'iam', 'accounts'), { uid: uid ?? null, st: 'A' })) {
    return fail('NOT_FOUND', `no active account ${String(uid)}`, { field: 'uid', value: String(uid) })
  }
  if (!has(rows(db, 'iam', 'role_codes'), { sys: sys ?? null, cd: role_cd ?? null })) {
    return unknownCode('iam', 'role_codes', 'cd', role_cd)
  }
  return add(db, 'iam', 'grants', { uid: uid ?? null, sys: sys ?? null, role_cd: role_cd ?? null }, 'granted')
}

const release: ActionHandler = (db, { svc, ver, env }) => {
  if (typeof ver !== 'string' || ver === '') return fail('INVALID_INPUT', 'ver is required')
  if (!has(rows(db, 'deployer', 'services'), { svc: svc ?? null })) {
    return fail('NOT_FOUND', `no service ${String(svc)}`, { field: 'svc', value: String(svc) })
  }
  if (!has(rows(db, 'deployer', 'envs'), { cd: env ?? null }))
    return unknownCode('deployer', 'envs', 'cd', env)
  if (
    env === 'P' &&
    !has(rows(db, 'deployer', 'releases'), { svc: svc ?? null, ver: ver ?? null, env: 'S' })
  ) {
    return fail('PRECONDITION_FAILED', 'release to S before P')
  }
  return add(db, 'deployer', 'releases', { svc: svc ?? null, ver: ver ?? null, env: env ?? null }, 'released')
}

const open: ActionHandler = (db, { svc, sev, grp }) => {
  if (!has(rows(db, 'incident', 'severities'), { cd: sev ?? null })) {
    return unknownCode('incident', 'severities', 'cd', sev)
  }
  if (!has(rows(db, 'incident', 'groups'), { grp: grp ?? null }))
    return unknownCode('incident', 'groups', 'grp', grp)
  const id = `INC-${rows(db, 'incident', 'tickets').length + 1}`
  const ticket = { id, svc: svc ?? null, sev: sev ?? null, grp: grp ?? null }
  return {
    ok: true,
    value: ticket,
    db: withRows(db, 'incident', 'tickets', [...rows(db, 'incident', 'tickets'), ticket]),
    change: { kind: 'opened', detail: ticket },
  }
}

export const companyActions: Record<string, Record<string, ActionHandler>> = {
  iam: { grant },
  deployer: { release },
  incident: { open },
}

export const renameCode = (
  db: Db,
  target: { system: string; resource: string; field: string },
  from: string,
  to: string,
): Db =>
  withRows(
    db,
    target.system,
    target.resource,
    rows(db, target.system, target.resource).map((row) =>
      row[target.field] === from ? { ...row, [target.field]: to } : row,
    ),
  )
