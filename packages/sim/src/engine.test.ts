import { expect, test } from 'vitest'
import { baselineActionTypes, baselineCatalog, baselineKnowledge } from './company/baseline.ts'
import { defaultSimConfig, runSimulation, type SimConfig, summarize } from './engine.ts'
import { DAY, HOUR } from './time.ts'

const config: SimConfig = {
  ...defaultSimConfig,
  knowledge: baselineKnowledge,
  catalog: baselineCatalog,
  actionTypes: baselineActionTypes,
}

test('the same seed gives the same 30 day result', async () => {
  const [first, second, other] = await Promise.all([
    runSimulation(config),
    runSimulation(config),
    runSimulation({ ...config, seed: 2 }),
  ])
  expect(second).toEqual(first)
  expect(summarize(other)).not.toEqual(summarize(first))
})

test('requests flow from intake to close and chatter is ignored', async () => {
  const result = await runSimulation({ ...config, days: 5, failureRate: 0 })
  const summary = summarize(result)
  expect(summary.requests).toBeGreaterThan(100)
  expect(summary.messages).toBeGreaterThan(summary.requests)
  expect(summary.tasks).toBe(summary.requests)
  expect(summary.done).toBe(summary.tasks)
  expect(summary.correct).toBe(summary.tasks)
  expect(result.outbox).toHaveLength(summary.tasks * 2)
  expect(result.outbox[0]?.body).toContain('접수했습니다')
  expect(result.db.iam?.grants?.length).toBeGreaterThan(0)
})

test('a code change in the source system breaks tasks that rely on the old code', async () => {
  const change = {
    at: 2 * DAY,
    kind: 'codeChange' as const,
    system: 'iam',
    resource: 'role_codes',
    field: 'cd',
    from: 'DP',
    to: 'DV',
  }
  const summary = summarize(await runSimulation({ ...config, days: 5, failureRate: 0, events: [change] }))
  expect(summary.reasons.AGENT_REPORTED_FAILURE).toBeGreaterThan(0)
  expect(summary.done + summary.escalated).toBe(summary.tasks)
})

test('a runtime outage escalates after the same error repeats', async () => {
  const outage = { at: 9 * HOUR, kind: 'runtimeOutage' as const, durationMs: 4 * HOUR, failureRate: 1 }
  const summary = summarize(await runSimulation({ ...config, days: 1, failureRate: 0, events: [outage] }))
  expect(summary.reasons['RUNTIME_ERROR:RUNTIME_UNAVAILABLE']).toBeGreaterThan(0)
  expect(summary.done).toBeGreaterThan(0)
})

test('a burst adds requests inside its window', async () => {
  const burst = { at: 10 * HOUR, kind: 'burst' as const, durationMs: 2 * HOUR, factor: 5 }
  const calm = await runSimulation({ ...config, days: 1 })
  const busy = await runSimulation({ ...config, days: 1, events: [burst] })
  expect(busy.messages).toBeGreaterThan(calm.messages + 20)
})
