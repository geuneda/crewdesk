import type { DiscrepancyReport } from '@crewdesk/core'
import { detectDiscrepancies, parseEvidence, parseKnowledge, reportsFromChange } from '@crewdesk/knowledge'
import { expect, test } from 'vitest'
import { loadBaseKnowledge, loadBaseQuestions } from './company/base.ts'
import { defaultSimConfig, runSimulation } from './engine.ts'
import { followChange } from './learning.ts'
import { renderStalenessReport, stalenessTimeline } from './reports/staleness.ts'
import { summarize } from './reports/summary.ts'
import { DAY, HOUR } from './time.ts'

const kb = await loadBaseKnowledge()
const questions = await loadBaseQuestions()
const codeChange = {
  at: 2 * DAY + 10 * HOUR,
  kind: 'codeChange' as const,
  system: 'iam',
  resource: 'role_codes',
  field: 'cd',
  from: 'DP',
  to: 'DV',
}
const reorg = { at: 8 * DAY + 11 * HOUR, kind: 'reorg' as const, from: 'PAY', to: 'FIN' }
const approverChange = {
  at: 11 * DAY + 9 * HOUR,
  kind: 'codeChange' as const,
  system: 'iam',
  resource: 'approvers',
  field: 'uid',
  from: 'u1001',
  to: 'u1005',
}
const result = await runSimulation({
  ...defaultSimConfig,
  kb,
  questions,
  days: 21,
  approvals: { ...defaultSimConfig.approvals, rejectRate: 0 },
  events: [codeChange, reorg, approverChange],
})
const rows = stalenessTimeline(result.discrepancies, result.knowledgeProposals, result.knowledgeChanges)
const row = (entryId: string, field: string) =>
  rows.find((item) => item.entryId === entryId && item.field === field)

test('a changed code value is caught at runtime, proposed after eval, and fixed after approval', () => {
  const fixed = row('role.deployer.deployer', 'value')
  expect(fixed).toMatchObject({ staleAt: codeChange.at, detectedBy: 'runtime', change: 'DP -> DV' })
  expect(fixed?.runtimeReports).toBeGreaterThan(0)
  expect(fixed?.detectedAt).toBeLessThan(3 * DAY)
  expect(fixed?.proposedAt).toBeGreaterThanOrEqual(fixed?.detectedAt ?? 0)
  expect(fixed?.fixedAt).toBeGreaterThan(fixed?.proposedAt ?? 0)
  expect(result.kb.entries.find((entry) => entry.id === 'role.deployer.deployer')?.data.value).toBe('DV')
})

test('after a reorg the detection and the fix proposal times are recorded for the group mapping', () => {
  for (const field of ['key', 'value']) {
    const fixed = row('group.PAY', field)
    expect(fixed).toMatchObject({ staleAt: reorg.at, detectedBy: 'systemEvent' })
    expect(fixed?.proposedAt).toBeGreaterThanOrEqual(reorg.at)
    expect(fixed?.fixedAt).toBeGreaterThan(reorg.at)
  }
  expect(result.kb.entries.find((entry) => entry.id === 'group.PAY')?.data).toMatchObject({
    key: 'FIN',
    value: 'G-FIN',
  })
})

test('a changed approver never fails a task and is found only through the system event', () => {
  const fixed = row('approves.iam.grant', 'approver')
  expect(fixed).toMatchObject({ detectedBy: 'systemEvent', runtimeReports: 0, change: 'u1001 -> u1005' })
  expect(fixed?.fixedAt).toBeGreaterThan(approverChange.at)
  const late = result.approvals.filter(
    (record) => record.actionType === 'iam.grant' && record.decidedAt > (fixed?.fixedAt ?? 0) + DAY,
  )
  expect(late.filter((record) => record.approver === 'u1001')).toEqual([])
})

test('approver changes always go to a human, mapping changes may be promoted', () => {
  const gates = result.gates.filter((gate) => String(gate.actionType).startsWith('knowledge.'))
  expect(gates.length).toBe(rows.length)
  expect(
    gates.filter((gate) => gate.actionType === 'knowledge.patchRelation').every((gate) => gate.human),
  ).toBe(true)
  expect(result.ruleChanges.some((change) => change.actionType === 'knowledge.patchRelation')).toBe(false)
})

test('the report lists every incident and work recovers after the fixes', () => {
  const report = renderStalenessReport(rows)
  expect(rows).toHaveLength(4)
  expect(report).toContain('| role.deployer.deployer | value | DP -> DV |')
  expect(report).toContain('| group.PAY |')
  const summary = summarize(result)
  expect(summary.done / summary.tasks).toBeGreaterThan(0.9)
  expect(result.usage.some((record) => record.stage === 'batch')).toBe(true)
})

test('a fix the owner rejects is shown as rejected, not as pending', () => {
  const [first] = rows
  if (!first) throw new Error('no rows')
  const { entryId, field } = first
  const rejected = stalenessTimeline(
    result.discrepancies,
    result.knowledgeProposals,
    [],
    [{ entryId, field }],
  )
  expect(rejected[0]?.rejected).toBe(true)
  expect(renderStalenessReport(rejected)).toContain('담당자 반려')
})

test('a runtime error is reported only for the entry field that comes from the failing column', () => {
  const used = kb.entries.filter((entry) => entry.data.concept === 'role' || entry.data.concept === 'env')
  const error = {
    code: 'UNKNOWN_CODE',
    message: '',
    detail: { system: 'iam', resource: 'role_codes', field: 'cd', value: 'RO' },
  }
  const reports = detectDiscrepancies(used, error, 't1', 5)
  expect(reports.map((report) => report.entryId)).toEqual(['role.deployer.reader', 'role.incident.reader'])
  expect(reports[0]).toMatchObject({ source: 'runtime', taskId: 't1', reportedAt: 5, expected: 'value=RO' })
  expect(parseEvidence(reports[0]?.evidence ?? '')?.query).toEqual({
    system: 'iam',
    resource: 'role_codes',
    where: { cd: 'RO' },
  })
  expect(detectDiscrepancies(used, { code: 'PRECONDITION_FAILED', message: '' }, 't1', 5)).toEqual([])
  expect(parseEvidence('not json')).toBeNull()
})

test('a system change touches only entries sourced from that column, and questions follow the fix', () => {
  const event = {
    seq: 1,
    at: 7,
    system: 'deployer',
    kind: 'codeChange',
    detail: { ...codeChange, system: 'deployer', resource: 'envs', from: 'P', to: 'PR' },
  }
  const reports: DiscrepancyReport[] = reportsFromChange(kb, event, 9)
  expect(reports.map((report) => report.entryId)).toEqual(['env.prod'])
  const change = { entryId: 'env.prod', field: 'value', from: 'P', to: 'PR', proposedAt: 9 }
  const followed = followChange(kb, questions, change)
  expect(followed.find((question) => question.id === 'q.deploy.prod')?.expect.params.env).toBe('PR')
  expect(
    followed.filter(
      (question, index) => question !== questions[index] && question.expect.params.env !== 'PR',
    ),
  ).toEqual(followed.filter((question) => question.expect.params.env !== 'PR'))
  expect(reportsFromChange(parseKnowledge([]), event, 9)).toEqual([])
})
