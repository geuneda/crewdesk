import { expect, test } from 'vitest'
import { loadBaseKnowledge } from './company/base.ts'
import { quotaSeats } from './company/ops.ts'
import { defaultSimConfig, runSimulation, type SimConfig } from './engine.ts'
import { renderBreakEvenReport, renderCostReport, runBreakEven, runCostComparison } from './reports/cost.ts'
import { DAY, HOUR } from './time.ts'

const config: SimConfig = {
  ...defaultSimConfig,
  kb: await loadBaseKnowledge(),
  approvals: { ...defaultSimConfig.approvals, enabled: false },
  failureRate: 0,
}

test('when a seat runs out, urgent work overflows to metered and the rest waits for the window', async () => {
  const drain = { at: 9 * HOUR, kind: 'seatDrain' as const, seat: 'seat-incident', units: 10_000_000 }
  const result = await runSimulation({
    ...config,
    days: 1,
    requestsPerDay: 200,
    seats: quotaSeats([{ lengthMs: 12 * HOUR, limit: 2_000_000 }]),
    events: [drain],
  })
  const incidents = result.tasks.filter((task) => task.domain === 'incident')
  const urgent = incidents.filter((task) => task.urgency === 'high').map((task) => task.id)
  const rest = incidents.filter((task) => task.urgency !== 'high').map((task) => task.id)
  const work = result.usage.filter((record) => record.stage === 'work')
  const early = (ids: string[]) =>
    work.filter((record) => ids.includes(record.taskId) && record.at < 12 * HOUR)
  expect(urgent.length).toBeGreaterThan(0)
  expect(early(urgent).length).toBeGreaterThan(0)
  expect(early(urgent).every((record) => record.seat === 'seat-overflow' && record.cost.unit === 'usd')).toBe(
    true,
  )
  expect(early(rest)).toEqual([])
  expect(new Set(result.parked.map((entry) => entry.taskId)).size).toBeGreaterThan(0)
  expect(result.parked.every((entry) => entry.until === 12 * HOUR)).toBe(true)
  expect(
    work.filter((record) => rest.includes(record.taskId)).every((record) => record.seat === 'seat-incident'),
  ).toBe(true)
  expect(result.tasks.filter((task) => task.status === 'done').length).toBe(result.tasks.length)
})

test('report 4: each optimisation step lowers the cost per task', async () => {
  const steps = await runCostComparison({ ...config, days: 3 })
  const costs = steps.map((step) => step.usdPerTask)
  expect(costs).toHaveLength(4)
  expect([...costs].sort((a, b) => b - a)).toEqual(costs)
  expect(costs[3]).toBeLessThan((costs[0] ?? 0) * 0.5)
  expect(renderCostReport(steps)).toContain('기준 대비')
})

test('report 6: seats win only above a break-even volume', async () => {
  const rows = await runBreakEven({ ...config, days: 7 }, [20, 640], 100)
  expect(rows.map((row) => row.cheaper)).toEqual(['metered', 'seat'])
  expect(rows[1]?.parkedTasks).toBeGreaterThan(0)
  expect(renderBreakEvenReport(rows, 100, 7)).toContain('손익분기점: 하루 요청 640건')
  expect(DAY).toBe(24 * HOUR)
})
