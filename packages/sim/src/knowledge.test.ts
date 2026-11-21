import { createReplayRuntime, type Recording, recordRuntime } from '@crewdesk/runtime'
import { expect, test } from 'vitest'
import { baseDistro } from './company/base.ts'
import { fakePricing } from './company/ops.ts'
import { companyScript } from './company/scripts.ts'
import { createVirtualClock } from './dummies/clock.ts'
import { createSeededRandom } from './dummies/random.ts'
import { createScriptedRuntime, defaultTokenModel } from './dummies/runtime.ts'
import { createEvalAgent } from './evalAgent.ts'
import { conditionKey as keyOf, measureKnowledgeEffect, renderKnowledgeReport } from './reports/knowledge.ts'

const base = {
  kb: baseDistro.kb,
  questions: baseDistro.questions,
  runs: 2,
  model: 'medium',
  pricing: fakePricing,
}

test('report 1 plumbing: record runs once, then measure accuracy and cost from the replay', async () => {
  const recordings: Recording[] = []
  const clock = createVirtualClock()
  const scripted = createScriptedRuntime({
    script: companyScript,
    clock,
    random: createSeededRandom(1),
    latencyMs: { min: 1000, max: 1000 },
    failureRate: () => 0,
    tokens: defaultTokenModel,
  })
  const recorder = recordRuntime(scripted, keyOf, (recording) => void recordings.push(recording))
  const measuring = measureKnowledgeEffect({
    ...base,
    clock,
    agentFor: (kb, recordUsage) => createEvalAgent({ kb, clock, runtime: recorder, recordUsage }),
  })
  await clock.runUntil(Number.POSITIVE_INFINITY)
  const live = await measuring
  expect(recordings).toHaveLength(baseDistro.questions.length * 2 * 2)

  const replay = createReplayRuntime(recordings, keyOf)
  const replayed = await measureKnowledgeEffect({
    ...base,
    clock: { now: () => 0, sleep: async () => {} },
    agentFor: (kb, recordUsage) =>
      createEvalAgent({ kb, clock: { now: () => 0, sleep: async () => {} }, runtime: replay, recordUsage }),
  })
  expect(replayed.map(({ secondsPerRun: _, ...row }) => row)).toEqual(
    live.map(({ secondsPerRun: _, ...row }) => row),
  )
  expect(replayed.map((row) => [row.condition, row.accuracy])).toEqual([
    ['without', 0],
    ['with', 1],
  ])
  expect(replayed[0]?.turnsPerRun).toBeGreaterThan(0)
  expect(live[1]?.secondsPerRun).toBeGreaterThan(0)
  const report = renderKnowledgeReport(replayed, 'scripted runtime (plumbing only)')
  expect(report).toContain('| 지식 있음 | 14 | 100% |')
  expect(report).toContain('| 지식 없음(시스템 구조만) | 14 | 0% |')
})

test('measuring refuses an empty run', async () => {
  await expect(
    measureKnowledgeEffect({
      ...base,
      runs: 0,
      clock: createVirtualClock(),
      agentFor: (kb) => createEvalAgent({ kb }),
    }),
  ).rejects.toThrow(/at least one/)
})

test('a recording that no longer replays stops the report instead of counting as an answer', async () => {
  const clock = { now: () => 0, sleep: async () => {} }
  const replay = createReplayRuntime([], keyOf)
  await expect(
    measureKnowledgeEffect({
      ...base,
      clock,
      agentFor: (kb, recordUsage) => createEvalAgent({ kb, clock, runtime: replay, recordUsage }),
    }),
  ).rejects.toThrow(/q.access.deployer \(without knowledge\) does not replay/)
})
