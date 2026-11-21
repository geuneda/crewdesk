import {
  createSdkMcpServer,
  type Options,
  type SDKMessage,
  query as sdkQuery,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  JsonObject,
  RunRequest,
  RuntimeEvent,
  RuntimePort,
  ToolCall,
  ToolHost,
  ToolResult,
} from '@crewdesk/core'
import { renderGuide } from '@crewdesk/knowledge'
import { z } from 'zod'

export type RunAgent = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>

export type ClaudeRuntimeOptions = {
  systemPrompt: string
  models: Record<string, string>
  run?: RunAgent
}

type Session = {
  request: RunRequest
  events: RuntimeEvent[]
  wake: (() => void) | null
  idle: (() => void)[]
  cancelled: boolean
  abort: AbortController
  calls: number
  lastExecuteOk: boolean
  usageSeen: ReadonlySet<string>
}

const SERVER = 'crewdesk'
const toolNames = {
  knowledge_lookup: 'knowledge.lookup',
  domain_query: 'domain.query',
  domain_execute: 'domain.execute',
}
const transientErrors = ['rate_limit', 'overloaded', 'server_error']

const outputOf = (result: ToolResult) =>
  result.status === 'ok'
    ? result.output
    : result.status === 'error'
      ? { code: result.code, message: result.message, ...(result.detail ? { detail: result.detail } : {}) }
      : {}

export const promptFor = (request: RunRequest): string =>
  [
    `요청: ${request.task.body}`,
    `업무 유형: ${request.task.taskType}`,
    request.knowledge.length > 0 ? `업무 지식:\n${renderGuide(request.knowledge)}` : '업무 지식: 없음',
  ].join('\n\n')

export const createClaudeRuntime = (options: ClaudeRuntimeOptions): RuntimePort => {
  const run: RunAgent = options.run ?? sdkQuery
  const paused = new Map<string, { session: Session; resume(tools: ToolHost): void }>()

  const push = (session: Session, event: RuntimeEvent) => {
    session.events = [...session.events, event]
    session.wake?.()
  }

  async function* stream(session: Session): AsyncGenerator<RuntimeEvent> {
    let settled = false
    try {
      for (;;) {
        const [event, ...rest] = session.events
        if (!event) {
          const waiting = session.idle
          session.idle = []
          for (const release of waiting) release()
          await new Promise<void>((resolve) => {
            session.wake = resolve
          })
          session.wake = null
          continue
        }
        session.events = rest
        settled = event.type === 'done' || event.type === 'error' || event.type === 'approvalRequired'
        yield event
        if (settled) return
        settled = false
      }
    } finally {
      if (!settled) {
        session.cancelled = true
        session.abort.abort()
        for (const release of session.idle) release()
      }
    }
  }

  const consumed = (session: Session) =>
    session.cancelled
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          session.idle = [...session.idle, resolve]
          session.wake?.()
        })

  const stopped: ToolResult = { status: 'error', code: 'RUN_CANCELLED', message: 'the run was stopped' }

  const invoke = async (session: Session, first: ToolHost, name: string, input: JsonObject) => {
    const call: ToolCall = { callId: `${session.request.task.id}-call-${++session.calls}`, tool: name, input }
    if (session.cancelled) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(outputOf(stopped)) }], isError: true }
    }
    push(session, { type: 'toolCall', ...call })
    await consumed(session)
    let tools = first
    let result = session.cancelled ? stopped : await tools.call(call)
    while (result.status === 'approvalRequired') {
      const resumeToken = `resume-${call.callId}`
      const resumed = new Promise<ToolHost>((resolve) => {
        paused.set(resumeToken, { session, resume: resolve })
      })
      push(session, {
        type: 'approvalRequired',
        callId: call.callId,
        approvalId: result.approvalId,
        resumeToken,
      })
      tools = await resumed
      await consumed(session)
      result = session.cancelled ? stopped : await tools.call(call)
    }
    if (name === 'domain.execute') session.lastExecuteOk = result.status === 'ok'
    push(session, {
      type: 'toolResult',
      callId: call.callId,
      ok: result.status === 'ok',
      output: outputOf(result),
    })
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(outputOf(result)) }],
      isError: result.status !== 'ok',
    }
  }

  const serverFor = (session: Session, tools: ToolHost) =>
    createSdkMcpServer({
      name: SERVER,
      tools: [
        tool(
          'knowledge_lookup',
          '업무 지식에서 코드값과 매핑을 찾는다. concept 는 role, env, severity, group 중 하나다.',
          {
            concept: z.string(),
            key: z.string().optional(),
            scope: z.string().optional(),
            text: z.string().optional(),
          },
          (args) => invoke(session, tools, toolNames.knowledge_lookup, JSON.parse(JSON.stringify(args))),
        ),
        tool(
          'domain_query',
          '사내 시스템의 자원을 조회한다. where 는 열 이름과 값의 쌍이다.',
          {
            system: z.string(),
            resource: z.string(),
            where: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
          },
          (args) => invoke(session, tools, toolNames.domain_query, JSON.parse(JSON.stringify(args))),
        ),
        tool(
          'domain_execute',
          '사내 시스템에 액션을 실행한다. 실행 전에 권한 검사와 승인을 거친다.',
          { system: z.string(), action: z.string(), params: z.record(z.string(), z.unknown()) },
          (args) => invoke(session, tools, toolNames.domain_execute, JSON.parse(JSON.stringify(args))),
        ),
      ],
    })

  const translate = (session: Session, message: SDKMessage): boolean => {
    if (message.type === 'assistant') {
      if (message.error && transientErrors.includes(message.error)) {
        push(session, { type: 'error', code: message.error, transient: true, message: message.error })
        return true
      }
      const { id, usage, content } = message.message
      if (!session.usageSeen.has(id)) {
        session.usageSeen = new Set([...session.usageSeen, id])
        push(session, {
          type: 'usage',
          model: session.request.model,
          inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
          cachedTokens: usage.cache_read_input_tokens ?? 0,
        })
      }
      for (const block of content) {
        if (block.type === 'text' && block.text !== '') push(session, { type: 'text', text: block.text })
      }
      return false
    }
    if (message.type !== 'result') return false
    if (message.subtype === 'success') {
      push(session, {
        type: 'done',
        ok: !message.is_error && session.lastExecuteOk,
        result: { text: message.result, costUsd: message.total_cost_usd, turns: message.num_turns },
      })
    } else {
      push(session, {
        type: 'error',
        code: message.subtype === 'error_max_turns' ? 'BUDGET_EXCEEDED' : message.subtype,
        transient: false,
        message: message.errors.join('; '),
      })
    }
    return true
  }

  const pump = async (session: Session, tools: ToolHost) => {
    try {
      const messages = run({
        prompt: promptFor(session.request),
        options: {
          model: options.models[session.request.model] ?? session.request.model,
          systemPrompt: options.systemPrompt,
          maxTurns: Math.max(1, session.request.budget.turns),
          tools: [],
          allowedTools: Object.keys(toolNames).map((name) => `mcp__${SERVER}__${name}`),
          mcpServers: { [SERVER]: serverFor(session, tools) },
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          abortController: session.abort,
        },
      })
      for await (const message of messages) {
        if (translate(session, message)) return
      }
      push(session, {
        type: 'error',
        code: 'STREAM_ENDED_EARLY',
        transient: false,
        message: 'no result message',
      })
    } catch (error) {
      push(session, {
        type: 'error',
        code: 'RUNTIME_FAILED',
        transient: false,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      session.abort.abort()
    }
  }

  return {
    start: (request, tools) => {
      const session: Session = {
        request,
        events: [],
        wake: null,
        idle: [],
        cancelled: false,
        abort: new AbortController(),
        calls: 0,
        lastExecuteOk: false,
        usageSeen: new Set(),
      }
      void pump(session, tools)
      return stream(session)
    },
    resume: (resumeToken, tools) => {
      const state = paused.get(resumeToken)
      paused.delete(resumeToken)
      if (!state) {
        return (async function* (): AsyncGenerator<RuntimeEvent> {
          yield { type: 'error', code: 'UNKNOWN_RESUME_TOKEN', transient: false, message: resumeToken }
        })()
      }
      state.resume(tools)
      return stream(state.session)
    },
  }
}
