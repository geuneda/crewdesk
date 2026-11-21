import type { DiscrepancyReport, JsonObject } from '@crewdesk/core'
import { parseEvidence } from '@crewdesk/knowledge'
import { DAY, HOUR } from '../time.ts'

export type StalenessRow = {
  entryId: string
  field: string
  change: string
  staleAt: number
  detectedAt: number
  detectedBy: DiscrepancyReport['source']
  runtimeReports: number
  proposedAt: number | null
  fixedAt: number | null
  rejected: boolean
}

export const stalenessTimeline = (
  discrepancies: DiscrepancyReport[],
  proposals: JsonObject[],
  changes: JsonObject[],
  rejections: JsonObject[] = [],
): StalenessRow[] => {
  const items = discrepancies.flatMap((report) => {
    const evidence = parseEvidence(report.evidence)
    return evidence
      ? [{ report, evidence, key: `${report.entryId}|${evidence.field}|${String(evidence.expected)}` }]
      : []
  })
  const origins = items
    .flatMap((item) =>
      item.evidence.changedAt === undefined ? [] : [{ ...item, staleAt: item.evidence.changedAt }],
    )
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.key === item.key && other.staleAt === item.staleAt) === index,
    )
    .sort((a, b) => a.staleAt - b.staleAt)
  return origins.map((origin) => {
    const until =
      origins.find((other) => other.key === origin.key && other.staleAt > origin.staleAt)?.staleAt ??
      Number.POSITIVE_INFINITY
    const within = (at: unknown) => typeof at === 'number' && at >= origin.staleAt && at < until
    const group = items.filter((item) => item.key === origin.key && within(item.report.reportedAt))
    const first = [...group].sort((a, b) => a.report.reportedAt - b.report.reportedAt)[0] ?? origin
    const { entryId } = origin.report
    const { field, expected, to } = origin.evidence
    const same = (record: JsonObject) =>
      record.entryId === entryId &&
      record.field === field &&
      record.from === expected &&
      within(record.proposedAt)
    const fix = changes.find(same)
    const proposal = fix ?? proposals.find(same)
    return {
      entryId,
      field,
      change: `${String(expected)} -> ${String(fix?.to ?? to)}`,
      staleAt: origin.staleAt,
      detectedAt: first.report.reportedAt,
      detectedBy: first.report.source,
      runtimeReports: group.filter((item) => item.report.source === 'runtime').length,
      proposedAt: typeof proposal?.proposedAt === 'number' ? proposal.proposedAt : null,
      fixedAt: typeof fix?.at === 'number' ? fix.at : null,
      rejected: rejections.some(same),
    }
  })
}

const stamp = (at: number) =>
  `${Math.floor(at / DAY) + 1}일 ${String(Math.floor((at % DAY) / HOUR)).padStart(2, '0')}시`
const hours = (from: number, to: number | null) => (to === null ? '-' : ((to - from) / HOUR).toFixed(1))

export const renderStalenessReport = (rows: StalenessRow[]): string =>
  [
    '# 보고서 3: 지식이 틀려진 시점부터 감지와 수정까지',
    '',
    '원천 시스템의 값이 바뀐 시점을 기준으로 잰다. 감지는 실행 중 불일치(runtime) 또는 시스템 변경 이벤트(systemEvent)다.',
    '수정은 평가를 통과한 제안을 담당자가 승인해 반영한 시점이다.',
    '',
    '| 지식 항목 | 필드 | 변경 | 틀려진 시점 | 첫 감지 | 감지까지(시간) | 실행 중 보고 수 | 제안까지(시간) | 수정까지(시간) |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${row.entryId} | ${row.field} | ${row.change} | ${stamp(row.staleAt)} | ${row.detectedBy} | ${hours(row.staleAt, row.detectedAt)} | ${row.runtimeReports} | ${hours(row.staleAt, row.proposedAt)} | ${row.rejected && row.fixedAt === null ? '담당자 반려' : hours(row.staleAt, row.fixedAt)} |`,
    ),
    '',
  ].join('\n')
