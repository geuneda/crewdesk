import type { RunRequest, RuntimeEvent, RuntimePort, Task, ToolHost } from '@crewdesk/core'
import { expect, test } from 'vitest'
import { type ExecutionDeps, executeTask } from './execute.ts'

const task: Task = {
  id: 't1',
  requester: 'u1',
  channel: 'c',
  thread: 'th',
  body: 'b',
  domain: 'access',
  taskType: 'access.grant',
  risk: 'low',
  urgency: 'normal',
  status: 'running',
  budget: { tokens: 1000, turns: 3, subagents: 0 },
  createdAt: 0,
}

const usage: RuntimeEvent = { type: 'usage', model: 'm', inputTokens: 100, outputTokens: 10, cachedTokens: 0 }

const runtimeOf = (run: (attempt: number, tools: ToolHost) => AsyncIterable<RuntimeEvent>): RuntimePort => {
  let attempts = 0
  return {
    start: (_: RunRequest, tools) => run(++attempts, tools),
    resume: async function* () {},
  }
}

const depsFor = (runtime: RuntimePort) => {
  const executed: unknown[] = []
  const deps: ExecutionDeps = {
    runtime,
    clock: { now: () => 0, sleep: async () => {} },
    systems: {
      query: async () => ({ ok: true, value: [] }),
      execute: async (action) => {
        executed.push(action)
        return { ok: true, value: {} }
      },
      changes: async () => [],
    },
    lookup: async () => [],
    recordUsage: async () => {},
    retryDelayMs: 1,
  }
  return { deps, executed }
}

const input = { task, agent: 'agent-access', model: 'm', knowledge: [] }
const grant = {
  callId: 'c1',
  tool: 'domain.execute',
  input: { system: 'iam', action: 'grant', params: { uid: 'u1' } },
}

test('stops when the turn budget is exceeded', async () => {
  const { deps } = depsFor(
    runtimeOf(async function* () {
      for (;;) yield usage
    }),
  )
  const result = await executeTask(deps, input)
  expect(result).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED', turns: 4 })
})

test('stops when the token budget is exceeded', async () => {
  const { deps } = depsFor(
    runtimeOf(async function* () {
      yield { ...usage, inputTokens: 5000 }
      yield { type: 'done', ok: true, result: {} }
    }),
  )
  expect((await executeTask(deps, input)).reason).toBe('BUDGET_EXCEEDED')
})

test('retries one transient error without repeating an action that already succeeded', async () => {
  const { deps, executed } = depsFor(
    runtimeOf(async function* (attempt, tools) {
      await tools.call(grant)
      if (attempt === 1) {
        yield { type: 'error', code: 'RUNTIME_UNAVAILABLE', transient: true, message: 'x' }
        return
      }
      yield { type: 'done', ok: true, result: {} }
    }),
  )
  const result = await executeTask(deps, input)
  expect(result.ok).toBe(true)
  expect(executed).toHaveLength(1)
  expect(result.actions).toHaveLength(1)
})

test('escalates when the same error comes twice, and at once when it is not transient', async () => {
  const failing = (transient: boolean) =>
    runtimeOf(async function* () {
      yield { type: 'error', code: 'BOOM', transient, message: 'x' }
    })
  expect((await executeTask(depsFor(failing(true)).deps, input)).reason).toBe('RUNTIME_ERROR:BOOM')
  expect((await executeTask(depsFor(failing(false)).deps, input)).reason).toBe('RUNTIME_ERROR:BOOM')
})

test('rejects malformed tool input and unknown tools', async () => {
  const results: unknown[] = []
  const { deps, executed } = depsFor(
    runtimeOf(async function* (_, tools) {
      results.push(await tools.call({ callId: 'c1', tool: 'domain.execute', input: { system: 1 } }))
      results.push(await tools.call({ callId: 'c2', tool: 'shell.run', input: {} }))
      yield { type: 'done', ok: false, result: {} }
    }),
  )
  await executeTask(deps, input)
  expect(results).toEqual([
    expect.objectContaining({ status: 'error', code: 'INVALID_INPUT' }),
    expect.objectContaining({ status: 'error', code: 'UNKNOWN_TOOL' }),
  ])
  expect(executed).toHaveLength(0)
})
