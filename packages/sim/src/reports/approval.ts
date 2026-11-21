import type { ApprovalRecord, JsonObject } from '@crewdesk/core'
import { DAY, MINUTE } from '../time.ts'

export type ApprovalDay = {
  day: number
  actions: number
  requested: number
  ratio: number
  medianWaitMinutes: number
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits))

export const approvalCurve = (records: ApprovalRecord[]): ApprovalDay[] => {
  const dayOf = (record: ApprovalRecord) => Math.floor((record.decidedAt - record.decidedInMs) / DAY)
  return [...new Set(records.map(dayOf))]
    .sort((a, b) => a - b)
    .map((day) => {
      const actions = records.filter((record) => dayOf(record) === day)
      const requested = actions.filter((record) => record.approver !== 'policy')
      return {
        day,
        actions: actions.length,
        requested: requested.length,
        ratio: round(requested.length / actions.length),
        medianWaitMinutes: round(median(requested.map((record) => record.decidedInMs)) / MINUTE, 1),
      }
    })
}

export const weeklyRatios = (curve: ApprovalDay[]): { week: number; actions: number; ratio: number }[] =>
  [...new Set(curve.map((point) => Math.floor(point.day / 7)))].map((week) => {
    const points = curve.filter((point) => Math.floor(point.day / 7) === week)
    const actions = points.reduce((sum, point) => sum + point.actions, 0)
    return { week, actions, ratio: round(points.reduce((sum, point) => sum + point.requested, 0) / actions) }
  })

export const renderApprovalReport = (records: ApprovalRecord[], ruleChanges: JsonObject[]): string => {
  const curve = approvalCurve(records)
  return [
    '# 보고서 2: 승인 요청 비율',
    '',
    '액션 중 사람의 승인을 요청한 비율이다. 같은 조건이 수정 없이 연속 승인되면 규칙이 한 단계씩 올라간다.',
    '',
    '## 주별',
    '',
    '| 주 | 액션 수 | 승인 요청 비율 |',
    '|---|---|---|',
    ...weeklyRatios(curve).map((week) => `| ${week.week + 1} | ${week.actions} | ${week.ratio} |`),
    '',
    '## 일별',
    '',
    '| 일 | 액션 수 | 승인 요청 | 비율 | 승인 대기 중앙값(분) |',
    '|---|---|---|---|---|',
    ...curve.map(
      (point) =>
        `| ${point.day + 1} | ${point.actions} | ${point.requested} | ${point.ratio} | ${point.medianWaitMinutes} |`,
    ),
    '',
    '## 규칙 변경',
    '',
    '| 일 | 액션 타입 | 조건 | 변경 | 원인 |',
    '|---|---|---|---|---|',
    ...ruleChanges.map(
      (change) =>
        `| ${Math.floor(Number(change.at) / DAY) + 1} | ${String(change.actionType)} | ${String(change.conditionKey)} | ${String(change.from)} -> ${String(change.level)} | ${String(change.cause)} |`,
    ),
    '',
  ].join('\n')
}
