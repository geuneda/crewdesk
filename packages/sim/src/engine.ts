import type { Domain, DomainAction, JsonObject, OutboundMessage, Task } from '@crewdesk/core'
import { actionTypesOf, catalogOf, fragmentFor, type KnowledgeBase, lookup } from '@crewdesk/knowledge'
import { companyActions } from './company/actions.ts'
import { buildCompanyDb } from './company/data.ts'
import { companyScript } from './company/scripts.ts'
import { createDesk } from './desk.ts'
import { createMemoryChannel } from './dummies/channel.ts'
import { createVirtualClock } from './dummies/clock.ts'
import { createRuleModel } from './dummies/model.ts'
import { createMemoryQueue } from './dummies/queue.ts'
import { createSeededRandom } from './dummies/random.ts'
import { createScriptedRuntime, defaultTokenModel, type TokenModel } from './dummies/runtime.ts'
import { createSqliteStore } from './dummies/store.ts'
import { createMemorySystems, type Db } from './dummies/systems.ts'
import { applyEvent, failureRateAt, type SimEvent } from './events.ts'
import { DAY, MINUTE } from './time.ts'
import { generateWorkload } from './workload.ts'

export type SimConfig = {
  seed: number
  days: number
  requestsPerDay: number
  chatterRatio: number
  latencyMs: { min: number; max: number }
  failureRate: number
  events: SimEvent[]
  kb: KnowledgeBase
  knowledgeEnabled: boolean
  tokens: TokenModel
}

export type SimResult = {
  messages: number
  tasks: Task[]
  traces: JsonObject[]
  usage: JsonObject[]
  outbox: OutboundMessage[]
  expected: Record<string, DomainAction>
  db: Db
}

export const defaultSimConfig = {
  seed: 1,
  days: 30,
  requestsPerDay: 40,
  chatterRatio: 0.3,
  latencyMs: { min: 2000, max: 20000 },
  failureRate: 0.01,
  events: [],
  knowledgeEnabled: true,
  tokens: defaultTokenModel,
} satisfies Partial<SimConfig>

const domains: Domain[] = ['access', 'deploy', 'incident']

export const runSimulation = async (config: SimConfig): Promise<SimResult> => {
  const clock = createVirtualClock()
  const store = createSqliteStore()
  const channel = createMemoryChannel()
  const systems = createMemorySystems({ db: buildCompanyDb(), actions: companyActions, clock })
  const model = createRuleModel({ strongModels: ['medium', 'large'] })
  const workload = generateWorkload(createSeededRandom(config.seed), config)
  const runtime = createScriptedRuntime({
    script: companyScript,
    clock,
    random: createSeededRandom(config.seed + 1),
    latencyMs: config.latencyMs,
    failureRate: () => failureRateAt(config.events, clock.now(), config.failureRate),
    tokens: config.tokens,
  })
  const queues = Object.fromEntries(domains.map((domain) => [domain, createMemoryQueue<Task>()]))
  const recordUsage = (report: JsonObject) => store.append('usage', { ...report, at: clock.now() })

  const desk = createDesk({
    store,
    queueFor: (domain) => queues[domain] ?? createMemoryQueue<Task>(),
    knowledgeFor: (task) => (config.knowledgeEnabled ? fragmentFor(config.kb, task.taskType) : []),
    workModel: () => 'medium',
    intake: {
      channel,
      model,
      store,
      clock,
      catalog: () => catalogOf(config.kb),
      models: { cheap: 'small', strong: 'medium' },
      confidenceThreshold: 0.7,
      budget: { tokens: 60000, turns: 12, subagents: 0 },
      agentFor: (domain) => `agent-${domain}`,
      recordUsage,
    },
    execution: {
      runtime,
      systems,
      clock,
      lookup: async (input) => (config.knowledgeEnabled ? lookup(config.kb, input) : []),
      recordUsage,
      retryDelayMs: MINUTE,
    },
    close: {
      channel,
      model,
      store,
      clock,
      systems,
      actionTypes: () => actionTypesOf(config.kb),
      replyModel: 'small',
      recordUsage,
    },
  })

  const feed = async () => {
    for (const { message } of workload) {
      await clock.sleep(message.at - clock.now())
      channel.inject(message)
      for (const polled of await channel.poll()) void desk.onMessage(polled)
    }
  }
  const inject = async () => {
    for (const event of [...config.events].sort((a, b) => a.at - b.at)) {
      await clock.sleep(event.at - clock.now())
      applyEvent(systems, event)
    }
  }
  void feed()
  void inject()
  await clock.runUntil(config.days * DAY)

  return {
    messages: workload.length,
    tasks: (await store.list('task')) as Task[],
    traces: await store.list('trace'),
    usage: await store.list('usage'),
    outbox: channel.outbox(),
    expected: Object.fromEntries(
      workload.flatMap((item) => (item.expected ? [[`task-${item.message.id}`, item.expected]] : [])),
    ),
    db: systems.snapshot(),
  }
}

type TraceAction = { action: DomainAction; result: { ok: boolean } }

export const summarize = (result: SimResult) => {
  const count = (status: Task['status']) => result.tasks.filter((task) => task.status === status).length
  const correct = result.traces.filter((trace) => {
    const last = (trace.actions as unknown as TraceAction[]).filter((done) => done.result.ok).at(-1)
    return (
      trace.ok === true &&
      JSON.stringify(last?.action) === JSON.stringify(result.expected[String(trace.taskId)])
    )
  }).length
  const reasonOf = (trace: JsonObject) => (typeof trace.reason === 'string' ? trace.reason : 'OK')
  const reasons = Object.fromEntries(
    [...new Set(result.traces.map(reasonOf))].map((reason) => [
      reason,
      result.traces.filter((trace) => reasonOf(trace) === reason).length,
    ]),
  )
  return {
    messages: result.messages,
    requests: Object.keys(result.expected).length,
    tasks: result.tasks.length,
    done: count('done'),
    escalated: count('escalated'),
    correct,
    reasons,
    tokens: result.usage.reduce((sum, record) => {
      const usage = record.usage as { inputTokens: number; outputTokens: number; cachedTokens: number }
      return sum + usage.inputTokens + usage.outputTokens + usage.cachedTokens
    }, 0),
  }
}
