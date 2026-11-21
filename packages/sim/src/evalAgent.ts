import type { Task } from '@crewdesk/core'
import type { EvalAgent } from '@crewdesk/eval'
import { catalogOf, type KnowledgeBase } from '@crewdesk/knowledge'
import { executeTask } from '@crewdesk/runtime'
import { companyActions } from './company/actions.ts'
import { buildCompanyDb } from './company/data.ts'
import { companyScript } from './company/scripts.ts'
import { createVirtualClock } from './dummies/clock.ts'
import { createSeededRandom } from './dummies/random.ts'
import { createScriptedRuntime, defaultTokenModel } from './dummies/runtime.ts'
import { createMemorySystems } from './dummies/systems.ts'

export const createScriptedEvalAgent =
  (kb: KnowledgeBase): EvalAgent =>
  async (question, knowledge, model) => {
    const clock = createVirtualClock()
    const item = catalogOf(kb).find((entry) => entry.taskType === question.taskType)
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
        runtime: createScriptedRuntime({
          script: companyScript,
          clock,
          random: createSeededRandom(1),
          latencyMs: { min: 0, max: 0 },
          failureRate: () => 0,
          tokens: defaultTokenModel,
        }),
        systems: createMemorySystems({ db: buildCompanyDb(), actions: companyActions, clock }),
        clock,
        lookup: (query) => knowledge.lookup(query),
        recordUsage: async () => {},
        authorize: async () => ({ status: 'allow' }),
        awaitDecision: async () => {},
        onExecuted: async () => {},
        onPause: async () => {},
        onResume: async () => {},
        retryDelayMs: 0,
        maxAttempts: 3,
      },
      { task, agent: `agent-${task.domain}`, model, knowledge: knowledge.fragment },
    )
    await clock.runUntil(Number.POSITIVE_INFINITY)
    return { actions: (await pending).actions }
  }
