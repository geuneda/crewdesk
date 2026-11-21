import type { ChannelPort, JsonObject, Task } from '@crewdesk/core'
import type { Placement } from '@crewdesk/ops'
import { expect, test } from 'vitest'
import { createDesk } from './desk.ts'
import { createMemoryChannel } from './dummies/channel.ts'
import { createVirtualClock } from './dummies/clock.ts'
import { createRuleModel } from './dummies/model.ts'
import { createMemoryQueue } from './dummies/queue.ts'
import { createSeededRandom } from './dummies/random.ts'
import { createScriptedRuntime, defaultTokenModel } from './dummies/runtime.ts'
import { createSqliteStore } from './dummies/store.ts'
import { createMemorySystems } from './dummies/systems.ts'

const setup = (
  wrap: (channel: ChannelPort) => ChannelPort = (channel) => channel,
  place: (now: number) => Placement = () => ({ kind: 'run', seat: 'seat-deploy', exclusive: true }),
) => {
  const clock = createVirtualClock()
  const store = createSqliteStore()
  const memory = createMemoryChannel()
  const channel = wrap(memory)
  const model = createRuleModel({ strongModels: [] })
  const queue = createMemoryQueue<Task>()
  const errors: unknown[] = []
  const systems = createMemorySystems({
    clock,
    db: { deployer: { releases: [] } },
    actions: {
      deployer: {
        release: (db, params) => ({
          ok: true,
          value: params,
          db: { deployer: { releases: [...(db.deployer?.releases ?? []), params] } },
          change: { kind: 'released', detail: params },
        }),
      },
    },
  })
  const desk = createDesk({
    store,
    queueFor: () => queue,
    knowledgeFor: async () => [],
    workModel: () => 'medium',
    place: () => place(clock.now()),
    onPlaced: () => {},
    onFinished: () => {},
    onError: (error) => void errors.push(error),
    intake: {
      channel,
      model,
      store,
      clock,
      catalog: () => [
        { domain: 'deploy', taskType: 'deploy.release', description: '', aliases: ['배포'], risk: 'high' },
      ],
      models: { cheap: 'small', strong: 'medium' },
      confidenceThreshold: 0.7,
      budget: { tokens: 60000, turns: 12, subagents: 0 },
      agentFor: (domain) => `agent-${domain}`,
      recordUsage: async () => {},
    },
    execution: {
      runtime: createScriptedRuntime({
        script: function* (request) {
          const params: JsonObject = { svc: request.task.body.split(' ')[0] ?? '', env: 'S' }
          const result = yield {
            tool: 'domain.execute',
            input: { system: 'deployer', action: 'release', params },
          }
          return { ok: result.status === 'ok', text: 'done', result: {} }
        },
        clock,
        random: createSeededRandom(1),
        latencyMs: { min: 1000, max: 1000 },
        failureRate: () => 0,
        tokens: defaultTokenModel,
      }),
      systems,
      clock,
      lookup: async () => [],
      recordUsage: async () => {},
      authorize: async () => ({ status: 'allow' }),
      awaitDecision: async () => {},
      onExecuted: async () => {},
      onDomainError: async () => {},
      retryDelayMs: 1,
      maxAttempts: 3,
    },
    close: {
      channel,
      model,
      store,
      clock,
      systems,
      actionTypes: () => [
        {
          id: 'deployer.release',
          system: 'deployer',
          action: 'release',
          domain: 'deploy',
          reversible: false,
          owner: 'u1',
          approvalLevel: 'always',
          promoteAfter: 3,
          conditionFields: ['env'],
          verify: { resource: 'releases', match: ['svc', 'env'] },
        },
      ],
      replyModel: 'small',
      recordUsage: async () => {},
      reportIncident: async () => {},
      markUsedOk: async () => {},
    },
  })
  const send = (id: string, body: string, mentionsAgent = true) =>
    desk.onMessage({
      id,
      channel: 'c',
      thread: 'th',
      sender: 'u1',
      body,
      mentionsAgent,
      isDirect: false,
      at: clock.now(),
    })
  return { desk, clock, store, memory, errors, send }
}

test('without knowledge or approvals a request is acknowledged, executed, verified, and answered', async () => {
  const { clock, store, memory, send } = setup()
  void send('m1', 'pay-api 배포')
  await clock.runUntil(Number.POSITIVE_INFINITY)
  expect(memory.outbox().map((message) => message.body)).toEqual([
    expect.stringContaining('접수했습니다'),
    expect.stringContaining('처리했습니다'),
  ])
  expect(await store.get('task', 'task-m1')).toMatchObject({ status: 'done' })
  expect(await store.get('trace', 'task-m1')).toMatchObject({ verified: true, ok: true, knowledge: [] })
})

test('a thread stays active until its last task ends', async () => {
  const { clock, store, send } = setup()
  void send('m1', 'pay-api 배포')
  void send('m2', 'pay-batch 배포')
  await clock.runUntil(1500)
  expect(await store.get('task', 'task-m1')).toMatchObject({ status: 'running' })
  void send('m3', 'live-event 배포', false)
  await clock.runUntil(Number.POSITIVE_INFINITY)
  expect((await store.list('task')).map((task) => task.status)).toEqual(['done', 'done', 'done'])
  void send('m4', 'data-mart 배포', false)
  await clock.runUntil(Number.POSITIVE_INFINITY)
  expect(await store.get('task', 'task-m4')).toBeNull()
})

test('a failure while closing one task is reported and does not block the next', async () => {
  let sends = 0
  const { clock, store, errors, send } = setup((channel) => ({
    ...channel,
    send: async (message) => {
      sends += 1
      if (sends === 3) throw new Error('channel down')
      await channel.send(message)
    },
  }))
  void send('m1', 'pay-api 배포')
  void send('m2', 'pay-batch 배포')
  await clock.runUntil(Number.POSITIVE_INFINITY)
  expect(errors).toHaveLength(1)
  expect(await store.get('task', 'task-m1')).toMatchObject({ status: 'escalated' })
  expect(await store.get('task', 'task-m2')).toMatchObject({ status: 'done' })
})

test('a task that waited for the seat is placed again when it gets the seat', async () => {
  let finished = 0
  const { clock, store, send } = setup(
    (channel) => ({
      ...channel,
      send: async (message) => {
        if (message.body.includes('처리했습니다')) finished += 1
        await channel.send(message)
      },
    }),
    (now) =>
      finished >= 1 && now < 60_000
        ? { kind: 'wait', until: 60_000 }
        : { kind: 'run', seat: 'seat-deploy', exclusive: true },
  )
  void send('m1', 'pay-api 배포')
  void send('m2', 'pay-batch 배포')
  await clock.runUntil(30_000)
  expect(await store.get('task', 'task-m1')).toMatchObject({ status: 'done' })
  expect(await store.get('task', 'task-m2')).toMatchObject({ status: 'queued' })
  await clock.runUntil(Number.POSITIVE_INFINITY)
  const trace = await store.get('trace', 'task-m2')
  expect(trace).toMatchObject({ ok: true })
  expect(Number(trace?.closedAt)).toBeGreaterThanOrEqual(60_000)
})
