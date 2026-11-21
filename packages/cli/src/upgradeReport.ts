import {
  applyOverlay,
  type Conflict,
  type Distro,
  type Overlay,
  planUpgrade,
  snapshotOf,
} from '@crewdesk/distro'
import { type Question, runEval } from '@crewdesk/eval'
import { patchEntry } from '@crewdesk/knowledge'
import { routeModel } from '@crewdesk/ops'
import { createEvalAgent, createSqliteStore } from '@crewdesk/sim'

export type UpgradeOutcome = {
  org: string
  status: 'applied' | 'conflict' | 'evalFailed'
  conflicts: Conflict[]
  accuracyBefore: number | null
  accuracyAfter: number | null
  questionsAdded: string[]
  questionsRemoved: string[]
}

export const accuracyOf = async (distro: Distro, questions: Question[]): Promise<number> => {
  const report = await runEval({
    questions,
    kb: distro.kb,
    agent: createEvalAgent({ kb: distro.kb }),
    cache: createSqliteStore(),
    promptVersion: distro.settings.promptVersion,
    model: routeModel(distro.settings.routes, 'eval'),
  })
  return report.accuracy
}

export const checkUpgrade = async (was: Distro, now: Distro, overlay: Overlay): Promise<UpgradeOutcome> => {
  const { conflicts } = planUpgrade(snapshotOf(was), snapshotOf(now), overlay)
  const ids = (distro: Distro) => distro.questions.map((question) => question.id)
  const outcome = {
    org: overlay.org,
    conflicts,
    questionsAdded: ids(now).filter((id) => !ids(was).includes(id)),
    questionsRemoved: ids(was).filter((id) => !ids(now).includes(id)),
  }
  if (conflicts.length > 0)
    return { ...outcome, status: 'conflict', accuracyBefore: null, accuracyAfter: null }
  if (was.questions.length === 0) {
    return { ...outcome, status: 'evalFailed', accuracyBefore: null, accuracyAfter: null }
  }
  const accuracyBefore = await accuracyOf(applyOverlay(was, overlay), was.questions)
  const accuracyAfter = await accuracyOf(applyOverlay(now, overlay), was.questions)
  return {
    ...outcome,
    status: accuracyAfter < accuracyBefore ? 'evalFailed' : 'applied',
    accuracyBefore,
    accuracyAfter,
  }
}

export const demoNextBase = (base: Distro): Distro => ({
  ...base,
  version: '1.1.0',
  settings: { ...base.settings, budget: { ...base.settings.budget, tokens: 250_000 } },
  kb: patchEntry(base.kb, 'actionType.iam.grant', { promoteAfter: 4 }),
})

const statusText = { applied: '적용', conflict: '충돌로 중단', evalFailed: '평가 하락으로 중단' }
const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`)

export const renderUpgradeReport = (from: string, to: string, outcomes: UpgradeOutcome[]): string =>
  [
    '# 보고서 5: 배포판 업그레이드와 조직별 덮어쓰기',
    '',
    `기본 배포판 ${from} 에서 ${to} 로 올린다. 덮어쓴 값의 기본값이 바뀌었으면 충돌로 보고 멈춘다.`,
    '충돌이 없으면 이전 판의 질문을 두 판에 똑같이 돌리고, 정답률이 내려가지 않을 때만 적용한다.',
    '',
    '| 조직 | 결과 | 충돌 수 | 평가(전) | 평가(후) |',
    '|---|---|---|---|---|',
    ...outcomes.map(
      (outcome) =>
        `| ${outcome.org} | ${statusText[outcome.status]} | ${outcome.conflicts.length} | ${percent(outcome.accuracyBefore)} | ${percent(outcome.accuracyAfter)} |`,
    ),
    '',
    '## 충돌 목록',
    '',
    '| 조직 | 경로 | 덮어쓴 값 | 이전 기본값 | 새 기본값 |',
    '|---|---|---|---|---|',
    ...outcomes.flatMap((outcome) =>
      outcome.conflicts.map(
        (conflict) =>
          `| ${outcome.org} | ${conflict.path} | ${JSON.stringify(conflict.overlay)} | ${JSON.stringify(conflict.was)} | ${JSON.stringify(conflict.now)} |`,
      ),
    ),
    '',
  ].join('\n')
