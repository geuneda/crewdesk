import type { Stage, UsageRecord } from '@crewdesk/core'
import { asMetered, flatRoutes } from '../company/ops.ts'
import { runSimulation, type SimConfig, type SimResult } from '../engine.ts'

const round = (value: number, digits = 4) => Number(value.toFixed(digits))

const usd = (usage: UsageRecord[], stage?: Stage) =>
  usage
    .filter((record) => record.cost.unit === 'usd' && (!stage || record.stage === stage))
    .reduce((sum, record) => sum + record.cost.amount, 0)

const closed = (result: SimResult) => result.traces.length

export type CostStep = {
  name: string
  tasks: number
  usdPerTask: number
  intakeUsdPerTask: number
  workUsdPerTask: number
  closeUsdPerTask: number
  tokensPerTask: number
}

export const runCostComparison = async (base: SimConfig): Promise<CostStep[]> => {
  const metered = { ...base, seats: asMetered(base.seats) }
  const plain = { ...base.tokens, caching: false, codeMode: false }
  const variants: { name: string; config: SimConfig }[] = [
    {
      name: '기준: 모든 단계 최상위 모델, 캐싱 없음, 도구 결과 누적',
      config: { ...metered, routes: flatRoutes('large'), intakeStrongModel: 'large', tokens: plain },
    },
    { name: '+ 단계·위험도별 모델 라우팅', config: { ...metered, tokens: plain } },
    {
      name: '+ 프롬프트 캐싱',
      config: { ...metered, tokens: { ...plain, caching: true } },
    },
    {
      name: '+ Code Mode 방식 도구',
      config: { ...metered, tokens: { ...plain, caching: true, codeMode: true } },
    },
  ]
  return Promise.all(
    variants.map(async ({ name, config }) => {
      const result = await runSimulation(config)
      const tasks = closed(result)
      const tokens = result.usage.reduce(
        (sum, record) => sum + record.inputTokens + record.outputTokens + record.cachedTokens,
        0,
      )
      return {
        name,
        tasks,
        usdPerTask: round(usd(result.usage) / tasks),
        intakeUsdPerTask: round(usd(result.usage, 'intake') / tasks),
        workUsdPerTask: round(usd(result.usage, 'work') / tasks),
        closeUsdPerTask: round(usd(result.usage, 'close') / tasks),
        tokensPerTask: Math.round(tokens / tasks),
      }
    }),
  )
}

export const renderCostReport = (steps: CostStep[]): string => {
  const first = steps[0]?.usdPerTask ?? 0
  return [
    '# 보고서 4: 라우팅과 캐싱 적용 전후의 업무당 비용',
    '',
    '비용은 가짜 가격표와 가짜 토큰 모형으로 계산한다. 절대값이 아니라 단계별 변화를 본다.',
    '',
    '| 구성 | 마감 업무 | 업무당 비용(USD) | 접수 | 실무 | 마감 | 업무당 토큰 | 기준 대비 |',
    '|---|---|---|---|---|---|---|---|',
    ...steps.map(
      (step) =>
        `| ${step.name} | ${step.tasks} | ${step.usdPerTask} | ${step.intakeUsdPerTask} | ${step.workUsdPerTask} | ${step.closeUsdPerTask} | ${step.tokensPerTask} | ${first ? Math.round((step.usdPerTask / first) * 100) : 0}% |`,
    ),
    '',
  ].join('\n')
}

export type BreakEvenRow = {
  requestsPerDay: number
  meteredTasks: number
  tasks: number
  meteredUsd: number
  seatUsd: number
  seatFeesUsd: number
  overflowUsd: number
  parkedTasks: number
  cheaper: 'metered' | 'seat' | 'incomparable'
}

export const runBreakEven = async (
  base: SimConfig,
  volumes: number[],
  seatMonthlyUsd: number,
): Promise<BreakEvenRow[]> => {
  const fees = base.seats.filter((seat) => seat.kind === 'quota').length * seatMonthlyUsd * (base.days / 30)
  return Promise.all(
    volumes.map(async (requestsPerDay) => {
      const [metered, seated] = await Promise.all([
        runSimulation({ ...base, requestsPerDay, seats: asMetered(base.seats) }),
        runSimulation({ ...base, requestsPerDay }),
      ])
      const meteredUsd = usd(metered.usage)
      const seatUsd = usd(seated.usage) + fees
      return {
        requestsPerDay,
        meteredTasks: closed(metered),
        tasks: closed(seated),
        meteredUsd: round(meteredUsd, 2),
        seatUsd: round(seatUsd, 2),
        seatFeesUsd: round(fees, 2),
        overflowUsd: round(usd(seated.usage.filter((record) => record.seat === 'seat-overflow')), 2),
        parkedTasks: new Set(seated.parked.map((entry) => entry.taskId)).size,
        cheaper:
          closed(seated) < closed(metered) * 0.98 ? 'incomparable' : seatUsd < meteredUsd ? 'seat' : 'metered',
      }
    }),
  )
}

const verdict = { seat: '좌석제', metered: '종량제', incomparable: '비교 불가(좌석제가 덜 처리함)' }

export const renderBreakEvenReport = (rows: BreakEvenRow[], seatMonthlyUsd: number, days: number): string => {
  const point = rows.find((row) => row.cheaper === 'seat')
  return [
    '# 보고서 6: 종량제 대 좌석제 손익분기점',
    '',
    `기간은 시뮬레이션 ${days}일이다. 좌석 요금은 좌석당 월 ${seatMonthlyUsd}달러로 가정했다. 가격과 한도는 가짜 값이다.`,
    '접수와 마감 회신은 두 구성 모두 종량제다. 좌석제에서 한도가 차면 긴급 업무는 종량제로 넘어가고 나머지는 대기한다.',
    '좌석제가 기간 안에 마감한 업무가 종량제의 98% 미만이면 비용을 직접 비교하지 않는다.',
    '',
    '| 하루 요청 | 종량제 마감 | 좌석제 마감 | 전부 종량제(USD) | 좌석제 합계(USD) | 좌석 요금 | 넘친 종량제 비용 | 대기한 업무 | 더 싼 쪽 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${row.requestsPerDay} | ${row.meteredTasks} | ${row.tasks} | ${row.meteredUsd} | ${row.seatUsd} | ${row.seatFeesUsd} | ${row.overflowUsd} | ${row.parkedTasks} | ${verdict[row.cheaper]} |`,
    ),
    '',
    point
      ? `손익분기점: 하루 요청 ${point.requestsPerDay}건 부근부터 좌석제가 싸다.`
      : '손익분기점: 이 범위에서는 종량제가 계속 싸다.',
    '',
  ].join('\n')
}
