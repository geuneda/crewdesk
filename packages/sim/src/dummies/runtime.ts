import type {
  ClockPort,
  JsonObject,
  RandomPort,
  RunRequest,
  RuntimeEvent,
  RuntimePort,
  ToolCall,
  ToolHost,
  ToolResult,
} from '@crewdesk/core'

export type ScriptStep = { tool: string; input: JsonObject }
export type ScriptEnd = { ok: boolean; text: string; result: JsonObject }
export type Script = (request: RunRequest) => Generator<ScriptStep, ScriptEnd, ToolResult>

export type TokenModel = {
  systemTokens: number
  toolSchemaTokens: number
  outputTokensPerTurn: number
  codeMode: boolean
  caching: boolean
}

export type ScriptedRuntimeOptions = {
  script: Script
  clock: ClockPort
  random: RandomPort
  latencyMs: { min: number; max: number }
  failureRate(): number
  tokens: TokenModel
}

type Session = {
  request: RunRequest
  steps: Generator<ScriptStep, ScriptEnd, ToolResult>
  history: number
  turn: number
  spent: number
  calls: number
}

const size = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4)

export const defaultTokenModel: TokenModel = {
  systemTokens: 12000,
  toolSchemaTokens: 8000,
  outputTokensPerTurn: 400,
  codeMode: true,
  caching: true,
}

export const createScriptedRuntime = (options: ScriptedRuntimeOptions): RuntimePort => {
  const { clock, random, tokens } = options
  const paused = new Map<string, { session: Session; call: ToolCall }>()
  let tokenSeq = 0

  const usage = (session: Session): Extract<RuntimeEvent, { type: 'usage' }> => {
    const prefix =
      tokens.systemTokens + size(session.request.knowledge) + (tokens.codeMode ? 0 : tokens.toolSchemaTokens)
    const fresh = size(session.request.task.body) + session.history
    const cached = tokens.caching && session.turn > 1 ? prefix : 0
    return {
      type: 'usage',
      model: session.request.model,
      inputTokens: prefix - cached + fresh,
      outputTokens: tokens.outputTokensPerTurn,
      cachedTokens: cached,
    }
  }

  async function* settle(
    session: Session,
    call: ToolCall,
    tools: ToolHost,
  ): AsyncGenerator<RuntimeEvent, ToolResult | null> {
    const result = await tools.call(call)
    if (result.status === 'approvalRequired') {
      const resumeToken = `resume-${session.request.task.id}-${++tokenSeq}`
      paused.set(resumeToken, { session, call })
      yield { type: 'approvalRequired', callId: call.callId, approvalId: result.approvalId, resumeToken }
      return null
    }
    session.history += tokens.codeMode ? 20 : size(call.input) + size(result)
    yield {
      type: 'toolResult',
      callId: call.callId,
      ok: result.status === 'ok',
      output: result.status === 'ok' ? result.output : { code: result.code, message: result.message },
    }
    return result
  }

  async function* turns(
    session: Session,
    tools: ToolHost,
    first: ToolResult | null,
  ): AsyncGenerator<RuntimeEvent> {
    let last = first
    for (;;) {
      await clock.sleep(
        options.latencyMs.min + random.next() * (options.latencyMs.max - options.latencyMs.min),
      )
      if (random.next() < options.failureRate()) {
        yield {
          type: 'error',
          code: 'RUNTIME_UNAVAILABLE',
          transient: true,
          message: 'injected runtime failure',
        }
        return
      }
      const next = usage({ ...session, turn: session.turn + 1 })
      const cost = next.inputTokens + next.outputTokens + next.cachedTokens
      const { budget } = session.request
      if (session.turn >= budget.turns || session.spent + cost > budget.tokens) {
        yield {
          type: 'error',
          code: 'BUDGET_EXCEEDED',
          transient: false,
          message: 'the run budget is used up',
        }
        return
      }
      session.turn += 1
      session.spent += cost
      yield next
      const step = last ? session.steps.next(last) : session.steps.next()
      if (step.done) {
        yield { type: 'text', text: step.value.text }
        yield { type: 'done', ok: step.value.ok, result: step.value.result }
        return
      }
      const call: ToolCall = { callId: `${session.request.task.id}-call-${++session.calls}`, ...step.value }
      yield { type: 'toolCall', ...call }
      last = yield* settle(session, call, tools)
      if (!last) return
    }
  }

  return {
    start: (request, tools) =>
      turns(
        { request, steps: options.script(request), history: 0, turn: 0, spent: 0, calls: 0 },
        tools,
        null,
      ),
    resume: async function* (resumeToken, tools) {
      const entry = paused.get(resumeToken)
      if (!entry) {
        yield { type: 'error', code: 'UNKNOWN_RESUME_TOKEN', transient: false, message: resumeToken }
        return
      }
      paused.delete(resumeToken)
      const result = yield* settle(entry.session, entry.call, tools)
      if (result) yield* turns(entry.session, tools, result)
    },
  }
}
