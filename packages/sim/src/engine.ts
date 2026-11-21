import { type ApprovalRule, createApprovalDesk } from '@crewdesk/approval'
import type {
  ApprovalRecord,
  Budget,
  DiscrepancyReport,
  Domain,
  DomainAction,
  JsonObject,
  OutboundMessage,
  Seat,
  Task,
  UsageRecord,
  UsageReport,
} from '@crewdesk/core'
import type { Distro } from '@crewdesk/distro'
import type { Question } from '@crewdesk/eval'
import {
  actionTypesOf,
  approverOf,
  catalogOf,
  createKnowledgeService,
  detectDiscrepancies,
  type KnowledgeBase,
} from '@crewdesk/knowledge'
import { createLedger, type Pricing, placeTask, type Route, routeModel } from '@crewdesk/ops'
import { type ApproverPolicy, createVirtualApprovers } from './approver.ts'
import { companyActions } from './company/actions.ts'
import { baseDistro } from './company/base.ts'
import { buildCompanyDb, people } from './company/data.ts'
import { fakePricing } from './company/ops.ts'
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
import { createLearning } from './learning.ts'
import { DAY, HOUR, MINUTE } from './time.ts'
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
  questions: Question[]
  knowledgeEnabled: boolean
  batchEveryMs: number
  staleAfterMs: number
  approvals: { enabled: boolean } & ApproverPolicy
  tokens: TokenModel
  seats: Seat[]
  pricing: Pricing
  routes: Route[]
  intakeStrongModel: string
  budget: Budget
}

export type SimResult = {
  messages: number
  tasks: Task[]
  traces: JsonObject[]
  usage: UsageRecord[]
  parked: JsonObject[]
  outbox: OutboundMessage[]
  approvals: ApprovalRecord[]
  gates: JsonObject[]
  knowledgeUse: JsonObject[]
  discrepancies: DiscrepancyReport[]
  knowledgeProposals: JsonObject[]
  knowledgeChanges: JsonObject[]
  knowledgeRejections: JsonObject[]
  kb: KnowledgeBase
  ruleChanges: JsonObject[]
  rules: ApprovalRule[]
  expected: Record<string, DomainAction>
  db: Db
}

export const simSettingsFrom = (distro: Distro) => ({
  kb: distro.kb,
  questions: distro.questions,
  routes: distro.settings.routes,
  seats: distro.settings.seats,
  intakeStrongModel: distro.settings.intakeStrongModel,
  budget: distro.settings.budget,
  tokens: { ...defaultTokenModel, ...distro.settings.tools },
  batchEveryMs: distro.settings.batchEveryHours * HOUR,
  staleAfterMs: distro.settings.staleAfterDays * DAY,
})

export const defaultSimConfig: SimConfig = {
  ...simSettingsFrom(baseDistro),
  seed: 1,
  days: 30,
  requestsPerDay: 40,
  chatterRatio: 0.3,
  latencyMs: { min: 2000, max: 20000 },
  failureRate: 0.01,
  events: [],
  knowledgeEnabled: true,
  approvals: { enabled: true, rejectRate: 0.02, adminRejectRate: 0.3, modifyRate: 0.03 },
  pricing: fakePricing,
}

const domains: Domain[] = ['access', 'deploy', 'incident']

export const runSimulation = async (config: SimConfig): Promise<SimResult> => {
  let kb = config.kb
  let questions = config.questions
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
    actionTypes: () => actionTypesOf(kb),
    approverFor: (type, action) => approverOf(kb, type, action.params),
    roleOf: (uid) => (people.find((person) => person.uid === uid)?.lead ? 'lead' : 'member'),
    humanApproval: () => config.approvals.enabled,
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

  const knowledge = createKnowledgeService({
    kb: () => kb,
    store,
    clock,
    enabled: () => config.knowledgeEnabled,
  })

  const desk = createDesk({
    store,
    queueFor: (domain) => queues[domain] ?? createMemoryQueue<Task>(),
    knowledgeFor: knowledge.fragment,
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
    onFinished: (task) => {
      ledger.unassign(task.id)
      approvals.forget(task.id)
    },
    onError,
    intake: {
      channel,
      model,
      store,
      clock,
      catalog: () => catalogOf(kb),
      models: { cheap: routeModel(config.routes, 'intake'), strong: config.intakeStrongModel },
      confidenceThreshold: 0.7,
      budget: config.budget,
      agentFor: (domain) => `agent-${domain}`,
      recordUsage,
    },
    execution: {
      runtime,
      systems,
      clock,
      lookup: knowledge.lookup,
      recordUsage,
      authorize: (task, action, used) =>
        approvals.authorize(
          task,
          action,
          used.some((entry) => knowledge.isStale(entry.id, config.staleAfterMs)),
        ),
      onDomainError: async (task, error, used) => {
        for (const report of detectDiscrepancies(used, error, task.id, clock.now())) {
          await store.append('discrepancy', report)
        }
      },
      onExecuted: approvals.recordExecution,
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
      actionTypes: () => actionTypesOf(kb),
      replyModel: routeModel(config.routes, 'close'),
      reportIncident: approvals.reportIncident,
      markUsedOk: knowledge.markUsedOk,
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
  const learning = createLearning({
    systems,
    store,
    clock,
    approvals,
    recordUsage,
    model: routeModel(config.routes, 'batch'),
    onError,
    kb: () => kb,
    setKb: (next) => {
      kb = next
    },
    questions: () => questions,
    setQuestions: (next) => {
      questions = next
    },
  })
  const learn = async () => {
    for (let at = config.batchEveryMs; at < config.days * DAY; at += config.batchEveryMs) {
      await clock.sleep(at - clock.now())
      await learning.run()
    }
  }
  void feed().catch(onError)
  void inject().catch(onError)
  void learn().catch(onError)
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
    gates: await store.list('gate'),
    knowledgeUse: await store.list('knowledgeUse'),
    discrepancies: (await store.list('discrepancy')) as DiscrepancyReport[],
    knowledgeProposals: await store.list('knowledgeProposal'),
    knowledgeChanges: await store.list('knowledgeChange'),
    knowledgeRejections: await store.list('knowledgeProposalRejected'),
    kb,
    ruleChanges: await store.list('ruleChange'),
    rules: approvals.rules(),
    expected: Object.fromEntries(
      workload.flatMap((item) => (item.expected ? [[`task-${item.message.id}`, item.expected]] : [])),
    ),
    db: systems.snapshot(),
  }
}
