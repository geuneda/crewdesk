import { expect, test } from 'vitest'
import { loadBaseKnowledge } from './company/base.ts'
import { defaultSimConfig, runSimulation } from './engine.ts'
import { approvalCurve, renderApprovalReport, weeklyRatios } from './reports/approval.ts'
import { summarize } from './reports/summary.ts'

const result = await runSimulation({ ...defaultSimConfig, kb: await loadBaseKnowledge() })

test('the share of actions that need a human falls over 30 days', () => {
  const weeks = weeklyRatios(approvalCurve(result.gates, result.approvals))
  const first = weeks[0]?.ratio ?? 0
  const last = weeks.at(-1)?.ratio ?? 1
  expect(first).toBeGreaterThan(0.85)
  expect(last).toBeLessThan(first - 0.3)
  expect(renderApprovalReport(result.gates, result.approvals, result.ruleChanges)).toContain('| 1 |')
})

test('the irreversible release never leaves human approval', () => {
  const levels = result.ruleChanges
    .filter((change) => change.actionType === 'deployer.release')
    .map((change) => change.level)
  expect(levels.length).toBeGreaterThan(0)
  expect(levels.every((level) => level === 'recommend' || level === 'always')).toBe(true)
  expect(
    result.approvals
      .filter((record) => record.actionType === 'deployer.release')
      .every((record) => record.approver !== 'policy'),
  ).toBe(true)
})

test('rejections demote and most work still finishes', () => {
  expect(result.ruleChanges.some((change) => change.cause === 'rejection')).toBe(true)
  const summary = summarize(result)
  expect(summary.done / summary.tasks).toBeGreaterThan(0.9)
  expect(summary.reasons.AGENT_REPORTED_FAILURE).toBeGreaterThan(0)
})

test('requests still waiting at the end count as requested', () => {
  const gates = [
    { at: 1, human: true },
    { at: 2, human: false },
  ]
  expect(approvalCurve(gates, [])).toEqual([
    { day: 0, actions: 2, requested: 1, ratio: 0.5, medianWaitMinutes: 0 },
  ])
})

test('every knowledge lookup is logged with its query, even when it finds nothing', async () => {
  const kb = await loadBaseKnowledge()
  const off = await runSimulation({ ...defaultSimConfig, kb, days: 1, knowledgeEnabled: false })
  const lookups = off.knowledgeUse.filter((use) => use.via === 'lookup')
  expect(lookups.length).toBeGreaterThan(0)
  expect(lookups.every((use) => Array.isArray(use.entryIds) && use.entryIds.length === 0)).toBe(true)
  expect(lookups[0]?.query).toMatchObject({ concept: expect.any(String) })
  expect(off.knowledgeUse.some((use) => use.via === 'fragment')).toBe(true)
})

test('with human approval switched off the permission check still runs', async () => {
  const result = await runSimulation({
    ...defaultSimConfig,
    kb: await loadBaseKnowledge(),
    days: 1,
    approvals: { ...defaultSimConfig.approvals, enabled: false },
  })
  expect(result.gates).toEqual([])
  expect(result.approvals).toEqual([])
  expect(summarize(result).done).toBeGreaterThan(0)
})
