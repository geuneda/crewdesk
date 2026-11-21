import type { ClockPort, JsonObject, RunRequest, UsageReport } from '@crewdesk/core'
import { type EvalAgent, gradeLastAction, type Question } from '@crewdesk/eval'
import { fragmentFor, type KnowledgeBase, lookup } from '@crewdesk/knowledge'
import { type Pricing, usdOf } from '@crewdesk/ops'

export type KnowledgeEffectRow = {
  condition: 'without' | 'with'
  runs: number
  accuracy: number
  usdPerRun: number
  tokensPerRun: number
  turnsPerRun: number
  secondsPerRun: number
}

export type KnowledgeEffectOptions = {
  kb: KnowledgeBase
  questions: Question[]
  runs: number
  model: string
  clock: ClockPort
  pricing: Pricing
  agentFor(kb: KnowledgeBase, recordUsage: (report: UsageReport) => Promise<void>): EvalAgent
}

export const conditionKey = (request: RunRequest): string =>
  `${request.task.id}|${request.knowledge.length > 0 ? 'with' : 'without'}`

export const withoutFacts = (kb: KnowledgeBase): KnowledgeBase => ({
  entries: kb.entries.filter((entry) => entry.kind === 'entity'),
})

const round = (value: number, digits: number) => Number(value.toFixed(digits))

const costOf = (pricing: Pricing, usage: UsageReport[], result: JsonObject | undefined): number =>
  typeof result?.costUsd === 'number'
    ? result.costUsd
    : usage.reduce((sum, report) => sum + (pricing[report.usage.model] ? usdOf(pricing, report.usage) : 0), 0)

const measure = async (
  options: KnowledgeEffectOptions,
  condition: KnowledgeEffectRow['condition'],
  kb: KnowledgeBase,
): Promise<KnowledgeEffectRow> => {
  let totals = { runs: 0, passed: 0, usd: 0, tokens: 0, turns: 0, ms: 0 }
  for (const question of options.questions) {
    for (let run = 0; run < options.runs; run += 1) {
      let usage: UsageReport[] = []
      const agent = options.agentFor(kb, async (report) => {
        usage = [...usage, report]
      })
      const startedAt = options.clock.now()
      const { actions, result, reason } = await agent(
        question,
        { fragment: fragmentFor(kb, question.taskType), lookup: async (query) => lookup(kb, query) },
        options.model,
      )
      if (reason?.includes('REPLAY_DIVERGED') || reason?.includes('NO_RECORDING')) {
        throw new Error(
          `the recording for ${question.id} (${condition} knowledge) does not replay: ${reason}`,
        )
      }
      totals = {
        runs: totals.runs + 1,
        passed: totals.passed + (gradeLastAction(question.expect, actions) ? 1 : 0),
        usd: totals.usd + costOf(options.pricing, usage, result),
        tokens:
          totals.tokens +
          usage.reduce(
            (sum, report) =>
              sum + report.usage.inputTokens + report.usage.outputTokens + report.usage.cachedTokens,
            0,
          ),
        turns: totals.turns + usage.length,
        ms: totals.ms + options.clock.now() - startedAt,
      }
    }
  }
  return {
    condition,
    runs: totals.runs,
    accuracy: round(totals.passed / totals.runs, 3),
    usdPerRun: round(totals.usd / totals.runs, 4),
    tokensPerRun: Math.round(totals.tokens / totals.runs),
    turnsPerRun: round(totals.turns / totals.runs, 1),
    secondsPerRun: round(totals.ms / totals.runs / 1000, 1),
  }
}

export const measureKnowledgeEffect = async (
  options: KnowledgeEffectOptions,
): Promise<KnowledgeEffectRow[]> => {
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.questions.length === 0) {
    throw new Error('measuring needs at least one question and one run')
  }
  return [
    await measure(options, 'without', withoutFacts(options.kb)),
    await measure(options, 'with', options.kb),
  ]
}

const labels = { without: '지식 없음(시스템 구조만)', with: '지식 있음' }

export const renderKnowledgeReport = (rows: KnowledgeEffectRow[], source: string): string =>
  [
    '# 보고서 1: 지식 있음과 없음의 정답률과 비용',
    '',
    `출처: ${source}`,
    '두 조건 모두 시스템 구조(자원과 액션의 이름)는 받는다. 지식 있음 조건만 코드값 매핑과 절차 규칙을 받는다.',
    '정답은 마지막으로 성공한 액션이 기대 액션과 같은지로 채점한다. 표본이 작으니 퍼센트보다 방향을 본다.',
    '',
    '| 조건 | 실행 수 | 정답률 | 실행당 비용(USD) | 실행당 토큰 | 실행당 턴 | 실행당 시간(초) |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${labels[row.condition]} | ${row.runs} | ${Math.round(row.accuracy * 100)}% | ${row.usdPerRun} | ${row.tokensPerRun} | ${row.turnsPerRun} | ${row.secondsPerRun} |`,
    ),
    '',
  ].join('\n')
