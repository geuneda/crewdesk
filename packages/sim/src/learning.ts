import type { ApprovalDesk } from '@crewdesk/approval'
import { type BatchDeps, createBatch, type KnowledgeChange } from '@crewdesk/batch'
import type { JsonObject, StorePort } from '@crewdesk/core'
import { type Question, runEval } from '@crewdesk/eval'
import { type KnowledgeBase, patchEntry } from '@crewdesk/knowledge'
import type { MemorySystems } from './dummies/systems.ts'
import { createScriptedEvalAgent } from './evalAgent.ts'
import { paramSources } from './workload.ts'

export type LearningDeps = Pick<BatchDeps, 'clock' | 'recordUsage' | 'model' | 'onError'> & {
  systems: MemorySystems
  store: StorePort
  approvals: ApprovalDesk
  kb(): KnowledgeBase
  setKb(kb: KnowledgeBase): void
  questions(): Question[]
  setQuestions(questions: Question[]): void
}

const sourceOf = (kb: KnowledgeBase, change: KnowledgeChange): unknown => {
  const sources = kb.entries.find((entry) => entry.id === change.entryId)?.data.sources
  return typeof sources === 'object' && sources !== null ? (sources as JsonObject)[change.field] : undefined
}

export const followChange = (
  kb: KnowledgeBase,
  questions: Question[],
  change: KnowledgeChange,
): Question[] => {
  const source = sourceOf(kb, change)
  return questions.map((question) => ({
    ...question,
    expect: {
      ...question.expect,
      params: Object.fromEntries(
        Object.entries(question.expect.params).map(([param, value]) => [
          param,
          paramSources[param] === source && value === change.from ? change.to : value,
        ]),
      ),
    },
  }))
}

export const createLearning = (deps: LearningDeps) =>
  createBatch({
    systems: deps.systems,
    store: deps.store,
    clock: deps.clock,
    kb: deps.kb,
    approvals: deps.approvals,
    recordUsage: deps.recordUsage,
    model: deps.model,
    onError: deps.onError,
    evaluate: async (candidate, change) => {
      const report = await runEval({
        questions: change ? followChange(deps.kb(), deps.questions(), change) : deps.questions(),
        kb: candidate,
        agent: createScriptedEvalAgent(candidate, deps.systems.snapshot(), deps.clock),
        cache: deps.store,
        promptVersion: 'sim',
        model: deps.model,
        environment: String((await deps.systems.changes(0)).length),
      })
      return report.accuracy
    },
    apply: async (change) => {
      deps.setQuestions(followChange(deps.kb(), deps.questions(), change))
      deps.setKb(patchEntry(deps.kb(), change.entryId, { [change.field]: change.to }))
      await deps.store.append('knowledgeChange', { ...change, at: deps.clock.now() })
    },
  })
