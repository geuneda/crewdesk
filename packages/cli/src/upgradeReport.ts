import {
  applyOverlay,
  type Conflict,
  type Distro,
  type Overlay,
  planUpgrade,
  snapshotOf,
} from '@crewdesk/distro'
import { runEval } from '@crewdesk/eval'
import { patchEntry } from '@crewdesk/knowledge'
import { routeModel } from '@crewdesk/ops'
import { createScriptedEvalAgent, createSqliteStore } from '@crewdesk/sim'

export type UpgradeOutcome = {
  org: string
  status: 'applied' | 'conflict' | 'evalFailed'
  conflicts: Conflict[]
  accuracyBefore: number | null
  accuracyAfter: number | null
}

export const accuracyOf = async (distro: Distro): Promise<number> => {
  const report = await runEval({
    questions: distro.questions,
    kb: distro.kb,
    agent: createScriptedEvalAgent(distro.kb),
    cache: createSqliteStore(),
    promptVersion: distro.settings.promptVersion,
    model: routeModel(distro.settings.routes, 'eval'),
  })
  return report.accuracy
}

export const checkUpgrade = async (was: Distro, now: Distro, overlay: Overlay): Promise<UpgradeOutcome> => {
  const { conflicts } = planUpgrade(snapshotOf(was), snapshotOf(now), overlay)
  if (conflicts.length > 0) {
    return { org: overlay.org, status: 'conflict', conflicts, accuracyBefore: null, accuracyAfter: null }
  }
  const accuracyBefore = await accuracyOf(applyOverlay(was, overlay))
  const accuracyAfter = await accuracyOf(applyOverlay(now, overlay))
  return {
    org: overlay.org,
    status: accuracyAfter < accuracyBefore ? 'evalFailed' : 'applied',
    conflicts,
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
    '충돌이 없으면 덮어쓰기를 적용한 지식으로 평가를 다시 돌리고, 정답률이 내려가지 않을 때만 적용한다.',
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
