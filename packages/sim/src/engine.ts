import { type ApprovalRule, createApprovalDesk } from '@crewdesk/approval'
import type {
  ApprovalRecord,
  Domain,
  DomainAction,
  JsonObject,
  OutboundMessage,
  Seat,
  Task,
  UsageRecord,
  UsageReport,
} from '@crewdesk/core'
import {
  actionTypesOf,
  approverOf,
  catalogOf,
  fragmentFor,
  type KnowledgeBase,
  lookup,
} from '@crewdesk/knowledge'
import { createLedger, type Pricing, placeTask, type Route, routeModel } from '@crewdesk/ops'
import { type ApproverPolicy, createVirtualApprovers } from './approver.ts'
import { companyActions } from './company/actions.ts'
import { buildCompanyDb, people } from './company/data.ts'
import { defaultRoutes, defaultSeats, fakePricing } from './company/ops.ts'
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
import { DAY, HOUR, isWorkday, MINUTE } from './time.ts'
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
  approvals: { enabled: boolean } & ApproverPolicy
  tokens: TokenModel
  seats: Seat[]
  pricing: Pricing
  routes: Route[]
  intakeStrongModel: string
}

export type SimResult = {
  messages: number
  tasks: Task[]
  traces: JsonObject[]
  usage: UsageRecord[]
  parked: JsonObject[]
  outbox: OutboundMessage[]
  approvals: ApprovalRecord[]
  ruleChanges: JsonObject[]
  rules: ApprovalRule[]
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
  approvals: { enabled: true, rejectRate: 0.02, adminRejectRate: 0.3, modifyRate: 0.03 },
  tokens: defaultTokenModel,
  seats: defaultSeats,
  pricing: fakePricing,
  routes: defaultRoutes,
  intakeStrongModel: 'medium',
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
  const ledger = createLedger({
    store,
    clock,
    pricing: config.pricing,
    seats: config.seats,
    sharedSeat: 'seat-intake',
  })
  const recordUsage = async (report: UsageReport) => void (await ledger.record(report))
  const seatOf = (id: string): Seat => {
    const seat = config.seats.find((candidate) => candidate.id === id)
    if (!seat) throw new Error(`the simulation needs a seat named ${id}`)
    return seat
  }
  let errors: unknown[] = []
  const onError = (error: unknown) => {
    errors = [...errors, error]
  }

  const approvals = createApprovalDesk({
    store,
    clock,
    actionTypes: () => actionTypesOf(config.kb),
    approverFor: (type) => approverOf(config.kb, type),
    roleOf: (uid) => (people.find((person) => person.uid === uid)?.lead ? 'lead' : 'member'),
    onPending: (pending) => void approve(pending).catch(onError),
    notify: (approver, text) =>
      channel.send({ channel: `dm-${approver}`, thread: 'approvals', body: text, at: clock.now() }),
  })
  const approve = createVirtualApprovers({
    clock,
    random: createSeededRandom(config.seed + 2),
    policy: config.approvals,
    decide: approvals.decide,
  })

  const desk = createDesk({
    store,
    queueFor: (domain) => queues[domain] ?? createMemoryQueue<Task>(),
    knowledgeFor: (task) => (config.knowledgeEnabled ? fragmentFor(config.kb, task.taskType) : []),
    workModel: (task) => routeModel(config.routes, 'work', task.risk),
    place: (task) => {
      const home = seatOf(`seat-${task.domain}`)
      const placement = placeTask(
        task.urgency,
        home,
        seatOf('seat-overflow'),
        ledger.left(home.id),
        ledger.resetAt(home.id),
      )
      if (placement.kind === 'wait') {
        void store
          .append('parked', { taskId: task.id, at: clock.now(), until: placement.until })
          .catch(onError)
      }
      return placement
    },
    onPlaced: (task, seat) => ledger.assign(task.id, seat),
    onError,
    intake: {
      channel,
      model,
      store,
      clock,
      catalog: () => catalogOf(config.kb),
      models: { cheap: routeModel(config.routes, 'intake'), strong: config.intakeStrongModel },
      confidenceThreshold: 0.7,
      budget: { tokens: 200_000, turns: 12, subagents: 0 },
      agentFor: (domain) => `agent-${domain}`,
      recordUsage,
    },
    execution: {
      runtime,
      systems,
      clock,
      lookup: async (input) => (config.knowledgeEnabled ? lookup(config.kb, input) : []),
      recordUsage,
      authorize: config.approvals.enabled ? approvals.authorize : async () => ({ status: 'allow' }),
      awaitDecision: approvals.awaitDecision,
      retryDelayMs: MINUTE,
      maxAttempts: 3,
    },
    close: {
      channel,
      model,
      store,
      clock,
      systems,
      actionTypes: () => actionTypesOf(config.kb),
      replyModel: routeModel(config.routes, 'close'),
      reportIncident: approvals.reportIncident,
      recordUsage,
    },
  })

  const feed = async () => {
    for (const { message } of workload) {
      await clock.sleep(message.at - clock.now())
      channel.inject(message)
      for (const polled of await channel.poll()) void desk.onMessage(polled).catch(onError)
    }
  }
  const inject = async () => {
    for (const event of [...config.events].sort((a, b) => a.at - b.at)) {
      await clock.sleep(event.at - clock.now())
      if (event.kind === 'seatDrain') ledger.drain(event.seat, event.units)
      else applyEvent(systems, event)
    }
  }
  const daily = async () => {
    for (let day = 0; day < config.days; day += 1) {
      await clock.sleep(day * DAY + 18 * HOUR - clock.now())
      if (isWorkday(day)) approvals.proposePromotions()
    }
  }
  void feed().catch(onError)
  void inject().catch(onError)
  void daily().catch(onError)
  await clock.runUntil(config.days * DAY)
  if (errors.length > 0) throw new AggregateError(errors, 'the simulation hit internal errors')

  return {
    messages: workload.length,
    tasks: (await store.list('task')) as Task[],
    traces: await store.list('trace'),
    usage: (await store.list('usage')) as UsageRecord[],
    parked: await store.list('parked'),
    outbox: channel.outbox(),
    approvals: (await store.list('approval')) as ApprovalRecord[],
    ruleChanges: await store.list('ruleChange'),
    rules: approvals.rules(),
    expected: Object.fromEntries(
      workload.flatMap((item) => (item.expected ? [[`task-${item.message.id}`, item.expected]] : [])),
    ),
    db: systems.snapshot(),
  }
}
