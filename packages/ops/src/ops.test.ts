import type { JsonObject, Seat } from '@crewdesk/core'
import { expect, test } from 'vitest'
import { createLedger, usdOf } from './ledger.ts'
import { routeModel } from './router.ts'
import { placeTask } from './seats.ts'

const HOUR = 3_600_000
const pricing = { small: { inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 0.1 } }
const metered: Seat = { id: 'seat-intake', agent: 'intake', kind: 'metered' }
const overflow: Seat = { id: 'seat-overflow', agent: 'overflow', kind: 'metered' }
const quota: Seat = {
  id: 'seat-access',
  agent: 'agent-access',
  kind: 'quota',
  windows: [
    { lengthMs: 5 * HOUR, limit: 1000 },
    { lengthMs: 24 * HOUR, limit: 1500 },
  ],
}
const usage = { model: 'small', inputTokens: 600, outputTokens: 100, cachedTokens: 1000 }

const setup = () => {
  let now = 0
  const stored: JsonObject[] = []
  const ledger = createLedger({
    store: {
      append: async (_, record) => void stored.push(record),
      put: async () => {},
      get: async () => null,
      list: async () => [],
    },
    clock: { now: () => now, sleep: async () => {} },
    pricing,
    seats: [metered, overflow, quota],
    sharedSeat: metered.id,
  })
  return {
    ledger,
    stored,
    at: (time: number) => {
      now = time
    },
  }
}

test('metered usage costs dollars by the price table', () => {
  expect(usdOf(pricing, usage)).toBeCloseTo((600 * 1 + 100 * 5 + 1000 * 0.1) / 1_000_000)
  expect(() => usdOf(pricing, { ...usage, model: 'unknown' })).toThrow(/no price/)
})

test('work on an assigned quota seat is recorded as a share of the window, the rest as dollars', async () => {
  const { ledger, stored } = setup()
  ledger.assign('t1', quota.id)
  const work = await ledger.record({ taskId: 't1', stage: 'work', usage, ok: true })
  const intake = await ledger.record({ taskId: 't1', stage: 'intake', usage, ok: true })
  expect(work).toMatchObject({ seat: 'seat-access', cost: { unit: 'quotaShare', amount: 0.8 } })
  expect(intake).toMatchObject({ seat: 'seat-intake', cost: { unit: 'usd' } })
  expect(stored).toHaveLength(2)
  expect(ledger.left(quota.id)).toBe(200)
})

test('a quota seat runs out per window and comes back when the window ends', async () => {
  const { ledger, at } = setup()
  ledger.assign('t1', quota.id)
  await ledger.record({ taskId: 't1', stage: 'work', usage, ok: true })
  ledger.drain(quota.id, 300)
  expect(ledger.left(quota.id)).toBe(-100)
  expect(ledger.resetAt(quota.id)).toBe(5 * HOUR)
  at(5 * HOUR)
  expect(ledger.left(quota.id)).toBe(400)
  ledger.drain(quota.id, 400)
  expect(ledger.resetAt(quota.id)).toBe(24 * HOUR)
  expect(ledger.left(metered.id)).toBe(Number.POSITIVE_INFINITY)
})

test('placement: quota left runs on the seat, urgent overflows to metered, the rest wait', () => {
  expect(placeTask('normal', quota, overflow, 10, 0)).toEqual({
    kind: 'run',
    seat: 'seat-access',
    exclusive: true,
  })
  expect(placeTask('high', quota, overflow, 0, 99)).toEqual({
    kind: 'run',
    seat: 'seat-overflow',
    exclusive: false,
  })
  expect(placeTask('normal', quota, overflow, 0, 99)).toEqual({ kind: 'wait', until: 99 })
  expect(placeTask('low', quota, overflow, -5, 99)).toEqual({ kind: 'wait', until: 99 })
  expect(placeTask('low', metered, overflow, 0, 99)).toEqual({
    kind: 'run',
    seat: 'seat-intake',
    exclusive: false,
  })
})

test('the router picks by stage and risk and fails on a missing stage', () => {
  const routes = [
    { stage: 'intake' as const, model: 'small' },
    { stage: 'work' as const, risk: 'high' as const, model: 'large' },
    { stage: 'work' as const, model: 'medium' },
  ]
  expect(routeModel(routes, 'work', 'high')).toBe('large')
  expect(routeModel(routes, 'work', 'low')).toBe('medium')
  expect(routeModel(routes, 'intake')).toBe('small')
  expect(() => routeModel(routes, 'close')).toThrow(/no model route/)
})
