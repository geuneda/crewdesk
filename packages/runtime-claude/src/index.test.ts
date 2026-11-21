import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RunRequest, RuntimeEvent } from '@crewdesk/core'
import { runtimeContract } from '@crewdesk/core/contracts'
import { expect, test } from 'vitest'
import { createClaudeRuntime, promptFor, type RunAgent } from './index.ts'

const assistant = (id: string, text: string, error?: string) =>
  ({
    type: 'assistant',
    message: {
      id,
      content: text ? [{ type: 'text', text }] : [],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 5,
      },
    },
    ...(error ? { error } : {}),
  }) as unknown as SDKMessage

const result = (fields: object) => ({ type: 'result', ...fields }) as unknown as SDKMessage

type Handler = (args: object) => Promise<{ isError?: boolean }>

const handlersOf = (options: Parameters<RunAgent>[0]['options']): Record<string, Handler> => {
  const server = Object.values(options.mcpServers ?? {})[0] as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  }
  return Object.fromEntries(
    Object.entries(server.instance._registeredTools).map(([name, registered]) => [name, registered.handler]),
  )
}

const fakeAgent: RunAgent = async function* ({ options }) {
  const maxTurns = options.maxTurns ?? 10
  yield assistant('msg-1', '')
  yield assistant('msg-1', '확인하겠습니다')
  await handlersOf(options).domain_execute?.({ system: 'iam', action: 'grant', params: { uid: 'u1' } })
  if (maxTurns < 2) {
    yield result({ subtype: 'error_max_turns', is_error: true, errors: ['max turns'], num_turns: 1 })
    return
  }
  yield assistant('msg-2', '처리했습니다')
  yield result({
    subtype: 'success',
    is_error: false,
    result: '처리했습니다',
    total_cost_usd: 0.012,
    num_turns: 2,
  })
}

const runtimeWith = (run: RunAgent) =>
  createClaudeRuntime({ systemPrompt: 'system', models: { medium: 'claude-sonnet-5-5' }, run })

runtimeContract('claude agent sdk adapter with a fake agent', () => ({
  runtime: runtimeWith(fakeAgent),
  settle: (pending) => pending,
}))

const request: RunRequest = {
  task: {
    id: 't1',
    requester: 'u',
    channel: 'c',
    thread: 'th',
    body: '김민준님에게 배포 시스템 배포자 권한 부여',
    domain: 'access',
    taskType: 'access.grant',
    risk: 'medium',
    urgency: 'normal',
    status: 'running',
    budget: { tokens: 100000, turns: 12, subagents: 0 },
    createdAt: 0,
  },
  agent: 'agent-access',
  model: 'medium',
  knowledge: [
    {
      id: 'role.deployer.deployer',
      kind: 'mapping',
      owner: 'u1001',
      confidence: 'confirmed',
      taskTypes: ['access.grant'],
      data: { concept: 'role', value: 'DP' },
    },
  ],
  budget: { tokens: 100000, turns: 12, subagents: 0 },
}

const collect = async (stream: AsyncIterable<RuntimeEvent>) => {
  const events: RuntimeEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

test('the agent gets only the three tools, the mapped model, and the knowledge in its prompt', async () => {
  const seen: Parameters<RunAgent>[0][] = []
  const runtime = runtimeWith((params) => {
    seen.push(params)
    return fakeAgent(params)
  })
  const events = await collect(runtime.start(request, { call: async () => ({ status: 'ok', output: {} }) }))
  const [{ prompt, options } = { prompt: '', options: {} }] = seen
  expect(options).toMatchObject({
    model: 'claude-sonnet-5-5',
    maxTurns: 12,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    allowedTools: [
      'mcp__crewdesk__knowledge_lookup',
      'mcp__crewdesk__domain_query',
      'mcp__crewdesk__domain_execute',
    ],
  })
  expect(prompt).toContain('[role.deployer.deployer]')
  expect(promptFor({ ...request, knowledge: [] })).toContain('업무 지식: 없음')
  expect(events.filter((event) => event.type === 'usage')).toEqual([
    { type: 'usage', model: 'medium', inputTokens: 105, outputTokens: 20, cachedTokens: 50 },
    { type: 'usage', model: 'medium', inputTokens: 105, outputTokens: 20, cachedTokens: 50 },
  ])
  expect(events.at(-1)).toEqual({
    type: 'done',
    ok: true,
    result: { text: '처리했습니다', costUsd: 0.012, turns: 2 },
  })
})

test('a run whose last action failed is not reported as done ok', async () => {
  const events = await collect(
    runtimeWith(fakeAgent).start(request, {
      call: async () => ({ status: 'error', code: 'UNKNOWN_CODE', message: 'no such code' }),
    }),
  )
  expect(events.at(-1)).toMatchObject({ type: 'done', ok: false })
})

test('overload is a transient error, a crash is not', async () => {
  const overloaded: RunAgent = async function* () {
    yield assistant('m', '', 'overloaded')
  }
  const crashing: RunAgent = async function* () {
    yield assistant('m', '')
    throw new Error('process exited')
  }
  const host = { call: async () => ({ status: 'ok' as const, output: {} }) }
  expect((await collect(runtimeWith(overloaded).start(request, host))).at(-1)).toMatchObject({
    type: 'error',
    transient: true,
  })
  expect((await collect(runtimeWith(crashing).start(request, host))).at(-1)).toMatchObject({
    type: 'error',
    code: 'RUNTIME_FAILED',
    transient: false,
  })
})

test('when the consumer stops at the budget, a tool call the agent makes afterwards never reaches the host', async () => {
  let hostCalls = 0
  let toolOutcome: { isError?: boolean } | undefined
  const greedy: RunAgent = async function* ({ options }) {
    yield assistant('msg-1', '')
    toolOutcome = await handlersOf(options).domain_execute?.({ system: 'iam', action: 'grant', params: {} })
    yield result({ subtype: 'success', is_error: false, result: '', total_cost_usd: 0, num_turns: 1 })
  }
  const stream = runtimeWith(greedy).start(request, {
    call: async () => {
      hostCalls += 1
      return { status: 'ok', output: {} }
    },
  })
  for await (const event of stream) {
    if (event.type === 'usage') break
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(hostCalls).toBe(0)
  expect(toolOutcome).toMatchObject({ isError: true })
})
