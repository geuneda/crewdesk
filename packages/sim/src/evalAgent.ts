import type { ClockPort, RuntimePort, Task, UsageReport } from '@crewdesk/core'
import type { EvalAgent } from '@crewdesk/eval'
import { catalogOf, type KnowledgeBase } from '@crewdesk/knowledge'
import { executeTask } from '@crewdesk/runtime'
import { companyActions } from './company/actions.ts'
import { buildCompanyDb } from './company/data.ts'
import { companyScript } from './company/scripts.ts'
import { createVirtualClock } from './dummies/clock.ts'
import { createSeededRandom } from './dummies/random.ts'
import { createScriptedRuntime, defaultTokenModel } from './dummies/runtime.ts'
import { createMemorySystems, type Db } from './dummies/systems.ts'

export type EvalAgentOptions = {
  kb: KnowledgeBase
  db?: Db
  clock?: ClockPort
  runtime?: RuntimePort
  recordUsage?(report: UsageReport): Promise<void>
}

export const createEvalAgent =
  (options: EvalAgentOptions): EvalAgent =>
  async (question, knowledge, model) => {
    const own = options.clock ? undefined : createVirtualClock()
    const clock = options.clock ?? own ?? createVirtualClock()
    const item = catalogOf(options.kb).find((entry) => entry.taskType === question.taskType)
    if (!item) throw new Error(`question ${question.id} uses an unknown task type ${question.taskType}`)
    const task: Task = {
      id: `eval-${question.id}`,
      requester: 'eval',
      channel: 'eval',
      thread: question.id,
      body: question.body,
      domain: item.domain,
      taskType: item.taskType,
      risk: item.risk,
      urgency: 'normal',
      status: 'running',
      budget: { tokens: 200_000, turns: 12, subagents: 0 },
      createdAt: 0,
    }
    const pending = executeTask(
      {
        runtime:
          options.runtime ??
          createScriptedRuntime({
            script: companyScript,
            clock,
            random: createSeededRandom(1),
            latencyMs: { min: 0, max: 0 },
            failureRate: () => 0,
            tokens: defaultTokenModel,
          }),
        systems: createMemorySystems({ db: options.db ?? buildCompanyDb(), actions: companyActions, clock }),
        clock,
        lookup: (query) => knowledge.lookup(query),
        recordUsage: (report) => options.recordUsage?.({ ...report, stage: 'eval' }) ?? Promise.resolve(),
        authorize: async () => ({ status: 'allow' }),
        awaitDecision: async () => {},
        onExecuted: async () => {},
        onDomainError: async () => {},
        identifyingParams: (action) => Object.keys(action.params),
        onPause: async () => {},
        onResume: async () => {},
        retryDelayMs: 0,
        maxAttempts: 3,
      },
      { task, agent: `agent-${task.domain}`, model, knowledge: knowledge.fragment },
    )
    await own?.runUntil(Number.POSITIVE_INFINITY)
    const execution = await pending
    return {
      actions: execution.actions,
      result: execution.result,
      ...(execution.reason ? { reason: execution.reason } : {}),
    }
  }
