import type { RunRequest, RuntimeEvent, RuntimePort, ToolHost } from '@crewdesk/core'
import { runtimeContract } from '@crewdesk/core/contracts'
import { expect, test } from 'vitest'
import { createReplayRuntime, type Recording, recordRuntime } from './replay.ts'

const live: RuntimePort = {
  start: async function* (request, tools) {
    yield { type: 'usage', model: request.model, inputTokens: 100, outputTokens: 10, cachedTokens: 0 }
    const call = { callId: 'c1', tool: 'domain.execute', input: { system: 's', action: 'a', params: {} } }
    yield { type: 'toolCall', ...call }
    const result = await tools.call(call)
    yield { type: 'toolResult', callId: 'c1', ok: result.status === 'ok', output: {} }
    yield { type: 'usage', model: request.model, inputTokens: 120, outputTokens: 10, cachedTokens: 0 }
    yield { type: 'text', text: 'finished' }
    yield { type: 'done', ok: true, result: { costUsd: 0.01 } }
  },
  resume: async function* () {},
}
const keyOf = (request: RunRequest) => `${request.task.id}|${request.knowledge.length}`
const ok: ToolHost = { call: async () => ({ status: 'ok', output: { fine: true } }) }
const collect = async (stream: AsyncIterable<RuntimeEvent>) => {
  const events: RuntimeEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
const request = (id: string): RunRequest => ({
  task: {
    id,
    requester: 'u',
    channel: 'c',
    thread: 't',
    body: 'b',
    domain: 'access',
    taskType: 'contract.probe',
    risk: 'low',
    urgency: 'normal',
    status: 'running',
    budget: { tokens: 100000, turns: 20, subagents: 0 },
    createdAt: 0,
  },
  agent: 'a',
  model: 'model-a',
  knowledge: [],
  budget: { tokens: 100000, turns: 20, subagents: 0 },
})

const record = async (id: string) => {
  const saved: Recording[] = []
  const events = await collect(
    recordRuntime(live, keyOf, (recording) => void saved.push(recording)).start(request(id), ok),
  )
  return { saved, events }
}

runtimeContract('replay', async () => ({
  runtime: createReplayRuntime((await record('task-1')).saved, keyOf),
  settle: (pending) => pending,
}))

test('a replay runs its tool calls against the live host and stops when the outcome differs', async () => {
  const { saved, events } = await record('t1')
  expect(saved).toHaveLength(1)
  const calls: unknown[] = []
  const replayed = await collect(
    createReplayRuntime(saved, keyOf).start(request('t1'), {
      call: async (call) => {
        calls.push(call)
        return { status: 'error', code: 'UNKNOWN_CODE', message: 'changed since the recording' }
      },
    }),
  )
  expect(calls).toHaveLength(1)
  expect(replayed.find((event) => event.type === 'toolResult')).toMatchObject({ ok: false })
  expect(replayed.at(-1)).toMatchObject({ type: 'error', code: 'REPLAY_DIVERGED', transient: false })
  const same = await collect(createReplayRuntime(saved, keyOf).start(request('t1'), ok))
  expect(same.map((event) => event.type)).toEqual(events.map((event) => event.type))
  expect(same.at(-1)).toEqual(events.at(-1))
})

test('several takes of one key are replayed in turn, and running out of takes is an error', async () => {
  const first = (await record('t1')).saved
  const takes = [
    ...first,
    { key: first[0]?.key ?? '', events: [{ type: 'done' as const, ok: false, result: {} }] },
  ]
  const runtime = createReplayRuntime(takes, keyOf)
  const lasts = [
    (await collect(runtime.start(request('t1'), ok))).at(-1),
    (await collect(runtime.start(request('t1'), ok))).at(-1),
  ]
  expect(lasts.map((event) => event?.type === 'done' && event.ok)).toEqual([true, false])
  expect((await collect(runtime.start(request('t1'), ok))).at(-1)).toMatchObject({ code: 'NO_RECORDING' })
  expect((await collect(runtime.start(request('other'), ok))).at(-1)).toMatchObject({ code: 'NO_RECORDING' })
})
