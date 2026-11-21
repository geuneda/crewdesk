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
    authorize: async () => ({ status: 'allow' }),
    awaitDecision: async () => {},
    onExecuted: async () => {},
    onDomainError: async () => {},
    identifyingParams: (action) => Object.keys(action.params),
    onPause: async () => {},
    onResume: async () => {},
    retryDelayMs: 1,
    maxAttempts: 3,
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

test('a retry with the same parameters in another order does not run the action again', async () => {
  const { deps, executed } = depsFor(
    runtimeOf(async function* (attempt, tools) {
      const params = attempt === 1 ? { uid: 'u1', sys: 'iam' } : { sys: 'iam', uid: 'u1' }
      await tools.call({ ...grant, input: { system: 'iam', action: 'grant', params } })
      if (attempt === 1) {
        yield { type: 'error', code: 'RUNTIME_UNAVAILABLE', transient: true, message: 'x' }
        return
      }
      yield { type: 'done', ok: true, result: {} }
    }),
  )
  await executeTask(deps, input)
  expect(executed).toHaveLength(1)
})

test('a retry gets only the budget that is left, and attempts are capped', async () => {
  const budgets: number[] = []
  let attempts = 0
  const { deps } = depsFor({
    start: async function* (request) {
      budgets.push(request.budget.turns)
      attempts += 1
      yield usage
      yield { type: 'error', code: `E${attempts}`, transient: true, message: 'x' }
    },
    resume: async function* () {},
  })
  const result = await executeTask(deps, {
    ...input,
    task: { ...task, budget: { ...task.budget, turns: 10 } },
  })
  expect(budgets).toEqual([10, 9, 8])
  expect(result.reason).toBe('RETRY_LIMIT')
})

test('a pending approval pauses the run and resumes it after the decision', async () => {
  const order: string[] = []
  let decided = false
  const { deps, executed } = depsFor({
    start: async function* (_, tools) {
      const result = await tools.call(grant)
      order.push(`start:${result.status}`)
      yield { type: 'approvalRequired', callId: 'c1', approvalId: 'ap-1', resumeToken: 'r1' }
    },
    resume: async function* (token, tools) {
      const result = await tools.call(grant)
      order.push(`resume:${token}:${result.status}`)
      yield { type: 'done', ok: true, result: {} }
    },
  })
  const result = await executeTask(
    {
      ...deps,
      authorize: async () => (decided ? { status: 'allow' } : { status: 'pending', approvalId: 'ap-1' }),
      awaitDecision: async (approvalId) => {
        order.push(`wait:${approvalId}`)
        decided = true
      },
      onPause: async () => void order.push('pause'),
      onResume: async () => void order.push('resume'),
    },
    input,
  )
  expect(order).toEqual(['start:approvalRequired', 'pause', 'wait:ap-1', 'resume', 'resume:r1:ok'])
  expect(result.ok).toBe(true)
  expect(executed).toHaveLength(1)
})

test('a denied action is not executed', async () => {
  const seen: unknown[] = []
  const { deps, executed } = depsFor(
    runtimeOf(async function* (_, tools) {
      seen.push(await tools.call(grant))
      yield { type: 'done', ok: false, result: {} }
    }),
  )
  await executeTask(
    { ...deps, authorize: async () => ({ status: 'denied', code: 'ACTION_NOT_PERMITTED', message: 'no' }) },
    input,
  )
  expect(seen).toEqual([expect.objectContaining({ status: 'error', code: 'ACTION_NOT_PERMITTED' })])
  expect(executed).toHaveLength(0)
})

test('only knowledge whose value an executed action carried counts as applied', async () => {
  const entry = (id: string, value: string, scope?: string) => ({
    id,
    kind: 'mapping' as const,
    owner: 'u1',
    confidence: 'confirmed' as const,
    taskTypes: [],
    data: { value, ...(scope ? { scope } : {}) },
  })
  const carried: string[][] = []
  const { deps } = depsFor(
    runtimeOf(async function* (_, tools) {
      await tools.call({
        ...grant,
        input: { system: 'iam', action: 'grant', params: { uid: 'u1', sys: 'incident', role_cd: 'RO' } },
      })
      yield { type: 'done', ok: true, result: {} }
    }),
  )
  const result = await executeTask(
    {
      ...deps,
      authorize: async (_, __, entries) => {
        carried.push(entries.map((item) => item.id))
        return { status: 'allow' }
      },
    },
    {
      ...input,
      knowledge: [
        entry('reader', 'RO', 'incident'),
        entry('other-reader', 'RO', 'deployer'),
        entry('admin', 'AD'),
      ],
    },
  )
  expect(carried).toEqual([['reader']])
  expect(result.knowledgeUsed).toEqual(['reader', 'other-reader', 'admin'])
  expect(result.knowledgeApplied).toEqual(['reader'])
})

test('the same action requested twice at once runs once', async () => {
  const outcomes: unknown[] = []
  const { deps, executed } = depsFor(
    runtimeOf(async function* (_, tools) {
      outcomes.push(...(await Promise.all([tools.call(grant), tools.call({ ...grant, callId: 'c2' })])))
      yield { type: 'done', ok: true, result: {} }
    }),
  )
  const result = await executeTask(
    {
      ...deps,
      authorize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { status: 'allow' }
      },
    },
    input,
  )
  expect(executed).toHaveLength(1)
  expect(result.actions).toHaveLength(1)
  expect(outcomes).toEqual([
    expect.objectContaining({ status: 'ok' }),
    expect.objectContaining({ status: 'ok' }),
  ])
})

test('a parameter the action type does not name cannot mark other knowledge as used', async () => {
  const entry = (id: string, scope: string) => ({
    id,
    kind: 'mapping' as const,
    owner: 'u1',
    confidence: 'confirmed' as const,
    taskTypes: [],
    data: { value: 'RO', scope },
  })
  const { deps } = depsFor(
    runtimeOf(async function* (_, tools) {
      await tools.call({
        ...grant,
        input: {
          system: 'iam',
          action: 'grant',
          params: { sys: 'incident', role_cd: 'RO', note: 'deployer' },
        },
      })
      yield { type: 'done', ok: true, result: {} }
    }),
  )
  const result = await executeTask(
    { ...deps, identifyingParams: () => ['sys', 'role_cd'] },
    { ...input, knowledge: [entry('incident-reader', 'incident'), entry('deployer-reader', 'deployer')] },
  )
  expect(result.knowledgeApplied).toEqual(['incident-reader'])
})

test('a repeat that arrives while the first is still being recorded shares its outcome', async () => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
  let outcomes: PromiseSettledResult<unknown>[] = []
  const { deps, executed } = depsFor(
    runtimeOf(async function* (_, tools) {
      const first = tools.call(grant)
      await pause()
      const second = tools.call({ ...grant, callId: 'c2' })
      await pause()
      release()
      outcomes = await Promise.allSettled([first, second])
      yield { type: 'done', ok: true, result: {} }
    }),
  )
  await executeTask(
    {
      ...deps,
      onExecuted: async () => {
        await held
        throw new Error('store down')
      },
    },
    input,
  ).catch(() => {})
  expect(executed).toHaveLength(1)
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
})
