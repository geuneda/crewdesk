import type { CatalogItem, RuntimeEvent, Task } from '@crewdesk/core'
import {
  channelContract,
  clockContract,
  domainSystemContract,
  modelContract,
  queueContract,
  randomContract,
  runtimeContract,
  storeContract,
} from '@crewdesk/core/contracts'
import { expect, test } from 'vitest'
import { createMemoryChannel } from './channel.ts'
import { createVirtualClock } from './clock.ts'
import { createRuleModel } from './model.ts'
import { createMemoryQueue } from './queue.ts'
import { createSeededRandom } from './random.ts'
import { createScriptedRuntime, defaultTokenModel, type Script } from './runtime.ts'
import { createSqliteStore } from './store.ts'
import { createMemorySystems } from './systems.ts'

const settleWith =
  (clock: ReturnType<typeof createVirtualClock>) =>
  async <T>(pending: Promise<T>): Promise<T> => {
    await clock.runUntil(Number.POSITIVE_INFINITY)
    return pending
  }

channelContract('memory', () => {
  const channel = createMemoryChannel()
  return { channel, inject: channel.inject }
})

queueContract('memory', () => createMemoryQueue<string>())

storeContract('sqlite in memory', () => createSqliteStore())

clockContract('virtual', () => {
  const clock = createVirtualClock()
  const settle = settleWith(clock)
  return { clock, settle: async (pending) => void (await settle(pending)) }
})

randomContract('seeded', () => createSeededRandom(7))

const probe: Script = function* () {
  const result = yield { tool: 'domain.execute', input: { action: 'probe' } }
  return { ok: result.status === 'ok', text: 'probe finished', result: {} }
}

runtimeContract('scripted', () => {
  const clock = createVirtualClock()
  const runtime = createScriptedRuntime({
    script: probe,
    clock,
    random: createSeededRandom(1),
    latencyMs: { min: 500, max: 3000 },
    failureRate: () => 0,
    tokens: defaultTokenModel,
  })
  return { runtime, settle: settleWith(clock) }
})

const catalog: CatalogItem[] = [
  {
    domain: 'access',
    taskType: 'access.grant',
    description: 'grant a role',
    aliases: ['권한'],
    risk: 'medium',
  },
  {
    domain: 'deploy',
    taskType: 'deploy.release',
    description: 'release a service',
    aliases: ['배포'],
    risk: 'high',
  },
]

modelContract('rule based', () => ({
  model: createRuleModel({ strongModels: [] }),
  catalog,
  sample: '결제 서비스 배포 부탁드립니다',
}))

domainSystemContract('memory', () => ({
  systems: createMemorySystems({
    clock: createVirtualClock(),
    db: { iam: { accounts: [{ id: 'u1' }] } },
    actions: {
      iam: {
        addAccount: (db, params) => ({
          ok: true,
          value: params,
          db: { ...db, iam: { ...db.iam, accounts: [...(db.iam?.accounts ?? []), params] } },
          change: { kind: 'accountAdded', detail: params },
        }),
      },
    },
  }),
  query: { system: 'iam', resource: 'accounts' },
  action: { system: 'iam', action: 'addAccount', params: { id: 'u2' } },
}))

test('seeded random repeats for the same seed', () => {
  const a = createSeededRandom(42)
  const b = createSeededRandom(42)
  expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()])
})

test('scripted runtime injects transient failures', async () => {
  const clock = createVirtualClock()
  const runtime = createScriptedRuntime({
    script: probe,
    clock,
    random: createSeededRandom(1),
    latencyMs: { min: 1, max: 2 },
    failureRate: () => 1,
    tokens: defaultTokenModel,
  })
  const events: RuntimeEvent[] = []
  const run = (async () => {
    for await (const event of runtime.start(
      {
        task: {
          id: 't',
          requester: 'u',
          channel: 'c',
          thread: 'th',
          body: 'b',
          domain: 'access',
          taskType: 'x',
          risk: 'low',
          urgency: 'low',
          status: 'running',
          budget: { tokens: 1, turns: 1, subagents: 0 },
          createdAt: 0,
        },
        agent: 'a',
        model: 'm',
        knowledge: [],
        budget: { tokens: 1, turns: 1, subagents: 0 },
      },
      { call: async () => ({ status: 'ok', output: {} }) },
    ))
      events.push(event)
  })()
  await clock.runUntil(Number.POSITIVE_INFINITY)
  await run
  expect(events).toEqual([expect.objectContaining({ type: 'error', transient: true })])
})

test('scripted runtime starts no turn it cannot pay for', async () => {
  const clock = createVirtualClock()
  const runtime = createScriptedRuntime({
    script: probe,
    clock,
    random: createSeededRandom(1),
    latencyMs: { min: 1, max: 2 },
    failureRate: () => 0,
    tokens: defaultTokenModel,
  })
  const events: RuntimeEvent[] = []
  const task: Task = {
    id: 't',
    requester: 'u',
    channel: 'c',
    thread: 'th',
    body: 'b',
    domain: 'access',
    taskType: 'x',
    risk: 'low',
    urgency: 'low',
    status: 'running',
    budget: { tokens: 100, turns: 5, subagents: 0 },
    createdAt: 0,
  }
  const run = (async () => {
    for await (const event of runtime.start(
      { task, agent: 'a', model: 'm', knowledge: [], budget: task.budget },
      { call: async () => ({ status: 'ok', output: {} }) },
    ))
      events.push(event)
  })()
  await clock.runUntil(Number.POSITIVE_INFINITY)
  await run
  expect(events).toEqual([
    expect.objectContaining({ type: 'error', code: 'BUDGET_EXCEEDED', transient: false }),
  ])
})
