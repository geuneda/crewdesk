import { describe, expect, test } from 'vitest'
import type { CatalogItem, RunRequest, RuntimeEvent, ToolCall, ToolHost, ToolResult } from '../messages.ts'
import type { DomainSystemPort, ModelPort, RuntimePort } from '../ports.ts'
import type { Task } from '../types.ts'

type Make<T> = () => T | Promise<T>

const task: Task = {
  id: 'task-1',
  requester: 'u1',
  channel: 'c1',
  thread: 't1',
  body: 'contract probe',
  domain: 'access',
  taskType: 'contract.probe',
  risk: 'low',
  urgency: 'normal',
  status: 'running',
  budget: { tokens: 100000, turns: 20, subagents: 0 },
  createdAt: 0,
}

const collect = async (stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> => {
  const events: RuntimeEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

const terminal = (event: RuntimeEvent | undefined) =>
  event?.type === 'done' || event?.type === 'error' || event?.type === 'approvalRequired'

const recordingHost = (answer: (call: ToolCall, attempt: number) => ToolResult) => {
  const calls: ToolCall[] = []
  const host: ToolHost = {
    call: async (call) => {
      calls.push(call)
      return answer(call, calls.filter((c) => c.callId === call.callId).length)
    },
  }
  return { host, calls }
}

export const runtimeContract = (
  name: string,
  make: Make<{ runtime: RuntimePort; settle<T>(pending: Promise<T>): Promise<T> }>,
) =>
  describe(`RuntimePort contract: ${name}`, () => {
    const request: RunRequest = {
      task,
      agent: 'agent-access',
      model: 'model-a',
      knowledge: [],
      budget: task.budget,
    }

    test('a run with at least one tool call ends with done and reports usage', async () => {
      const { runtime, settle } = await make()
      const { host, calls } = recordingHost(() => ({ status: 'ok', output: { fine: true } }))
      const events = await settle(collect(runtime.start(request, host)))
      expect(events.at(-1)?.type).toBe('done')
      expect(events.filter(terminal)).toHaveLength(1)
      expect(events.some((e) => e.type === 'usage')).toBe(true)
      expect(calls.length).toBeGreaterThan(0)
      const callIds = events.flatMap((e) => (e.type === 'toolCall' ? [e.callId] : []))
      const resultIds = events.flatMap((e) => (e.type === 'toolResult' ? [e.callId] : []))
      expect(resultIds).toEqual(callIds)
    })

    test('an approval pause ends the stream and resume repeats the paused call', async () => {
      const { runtime, settle } = await make()
      const { host, calls } = recordingHost((_, attempt) =>
        attempt === 1 ? { status: 'approvalRequired', approvalId: 'ap-1' } : { status: 'ok', output: {} },
      )
      const first = await settle(collect(runtime.start(request, host)))
      const pause = first.at(-1)
      if (pause?.type !== 'approvalRequired') throw new Error('expected an approval pause')
      expect(pause.approvalId).toBe('ap-1')
      const paused = calls.at(-1)
      const rest = await settle(collect(runtime.resume(pause.resumeToken, host)))
      expect(calls.filter((c) => c.callId === paused?.callId)).toHaveLength(2)
      expect(rest.at(-1)?.type).toBe('done')
    })

    test('a run never starts more turns than the budget allows', async () => {
      const { runtime, settle } = await make()
      const { host } = recordingHost(() => ({ status: 'ok', output: {} }))
      const tight = { ...request, budget: { ...request.budget, turns: 1 } }
      const events = await settle(collect(runtime.start(tight, host)))
      expect(events.filter((e) => e.type === 'usage').length).toBeLessThanOrEqual(1)
      expect(terminal(events.at(-1))).toBe(true)
    })

    test('resume with an unknown token ends with a non-transient error', async () => {
      const { runtime, settle } = await make()
      const { host } = recordingHost(() => ({ status: 'ok', output: {} }))
      const events = await settle(collect(runtime.resume('no-such-token', host)))
      const last = events.at(-1)
      expect(last?.type === 'error' && !last.transient).toBe(true)
    })
  })

export const modelContract = (
  name: string,
  make: Make<{ model: ModelPort; catalog: CatalogItem[]; sample: string }>,
) =>
  describe(`ModelPort contract: ${name}`, () => {
    test('classify picks a catalog entry with a confidence and usage', async () => {
      const { model, catalog, sample } = await make()
      const { classification, confidence, usage } = await model.classify({
        model: 'model-a',
        body: sample,
        catalog,
      })
      expect(catalog.some((item) => item.taskType === classification?.taskType)).toBe(true)
      expect(confidence).toBeGreaterThan(0)
      expect(confidence).toBeLessThanOrEqual(1)
      expect(usage.inputTokens).toBeGreaterThan(0)
      expect(usage.model).toBe('model-a')
    })

    test('reply returns text and usage', async () => {
      const { model } = await make()
      const { text, usage } = await model.reply({ model: 'model-a', task, outcome: 'done', facts: {} })
      expect(text.length).toBeGreaterThan(0)
      expect(usage.outputTokens).toBeGreaterThan(0)
    })
  })

export const domainSystemContract = (
  name: string,
  make: Make<{
    systems: DomainSystemPort
    query: { system: string; resource: string }
    action: { system: string; action: string; params: Record<string, string> }
  }>,
) =>
  describe(`DomainSystemPort contract: ${name}`, () => {
    test('query returns rows for a known resource and an error for an unknown one', async () => {
      const { systems, query } = await make()
      const known = await systems.query(query)
      expect(known.ok && known.value.length > 0).toBe(true)
      const unknown = await systems.query({ system: 'no-such-system', resource: 'x' })
      expect(unknown.ok).toBe(false)
    })

    test('execute applies an action and records a change with a growing seq', async () => {
      const { systems, action } = await make()
      const before = await systems.changes(0)
      const result = await systems.execute(action)
      expect(result.ok).toBe(true)
      const after = await systems.changes(0)
      expect(after.length).toBe(before.length + 1)
      const last = after.at(-1)
      expect(await systems.changes(last?.seq ?? 0)).toEqual([])
    })

    test('execute rejects an unknown action without recording a change', async () => {
      const { systems, action } = await make()
      const result = await systems.execute({ ...action, action: 'no-such-action' })
      expect(result.ok).toBe(false)
      expect(await systems.changes(0)).toEqual([])
    })
  })
