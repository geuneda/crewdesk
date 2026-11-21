import {
  type Authorization,
  type Budget,
  type ClockPort,
  canonicalJson,
  type DomainAction,
  type DomainResult,
  type DomainSystemPort,
  type Json,
  type JsonObject,
  type KnowledgeEntry,
  type RuntimeEvent,
  type RuntimePort,
  type Task,
  type ToolHost,
  type ToolResult,
  type UsageReport,
} from '@crewdesk/core'

export type ExecutionDeps = {
  runtime: RuntimePort
  systems: DomainSystemPort
  clock: ClockPort
  lookup(input: JsonObject, task: Task): Promise<KnowledgeEntry[]>
  recordUsage(report: UsageReport): Promise<void>
  authorize(task: Task, action: DomainAction): Promise<Authorization>
  awaitDecision(approvalId: string): Promise<void>
  onPause(task: Task): Promise<void>
  onResume(task: Task): Promise<void>
  retryDelayMs: number
  maxAttempts: number
}

export type ExecutionInput = { task: Task; agent: string; model: string; knowledge: KnowledgeEntry[] }
export type ExecutedAction = { action: DomainAction; result: DomainResult<Json> }

export type ExecutionResult = {
  ok: boolean
  reason?: string
  actions: ExecutedAction[]
  knowledgeUsed: string[]
  result: JsonObject
  turns: number
  tokens: number
}

type Stop =
  | Extract<RuntimeEvent, { type: 'done' | 'error' | 'approvalRequired' }>
  | { type: 'budgetExceeded' }
  | { type: 'ended' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toToolResult = (result: DomainResult<Json>): ToolResult =>
  result.ok
    ? { status: 'ok', output: result.value }
    : {
        status: 'error',
        code: result.error.code,
        message: result.error.message,
        ...(result.error.detail ? { detail: result.error.detail } : {}),
      }

const invalid = (tool: string): ToolResult => ({
  status: 'error',
  code: 'INVALID_INPUT',
  message: `invalid input for ${tool}`,
})

export const executeTask = async (deps: ExecutionDeps, input: ExecutionInput): Promise<ExecutionResult> => {
  const { task } = input
  let actions: ExecutedAction[] = []
  let lookedUp: string[] = []
  let tokens = 0
  let turns = 0
  let attempts = 1
  let errorCounts: Record<string, number> = {}

  const tools: ToolHost = {
    call: async ({ tool, input: args }) => {
      if (tool === 'knowledge.lookup') {
        const entries = await deps.lookup(args, task)
        lookedUp = [...lookedUp, ...entries.map((entry) => entry.id)]
        return { status: 'ok', output: { entries } }
      }
      const { system, resource, action, where, params } = args
      if (tool === 'domain.query') {
        if (typeof system !== 'string' || typeof resource !== 'string') return invalid(tool)
        const filters = isRecord(where)
          ? Object.fromEntries(
              Object.entries(where).filter(
                (pair): pair is [string, string | number] =>
                  typeof pair[1] === 'string' || typeof pair[1] === 'number',
              ),
            )
          : {}
        return toToolResult(await deps.systems.query({ system, resource, where: filters }))
      }
      if (tool === 'domain.execute') {
        if (typeof system !== 'string' || typeof action !== 'string' || !isRecord(params))
          return invalid(tool)
        const request: DomainAction = { system, action, params: params as JsonObject }
        const key = canonicalJson(request)
        const prior = actions.find((done) => done.result.ok && canonicalJson(done.action) === key)
        if (prior) return toToolResult(prior.result)
        const permit = await deps.authorize(task, request)
        if (permit.status === 'pending') return { status: 'approvalRequired', approvalId: permit.approvalId }
        if (permit.status === 'denied') return { status: 'error', code: permit.code, message: permit.message }
        const result = await deps.systems.execute(request)
        actions = [...actions, { action: request, result }]
        return toToolResult(result)
      }
      return { status: 'error', code: 'UNKNOWN_TOOL', message: tool }
    },
  }

  const consume = async (stream: AsyncIterable<RuntimeEvent>): Promise<Stop> => {
    for await (const event of stream) {
      if (event.type === 'usage') {
        const { type: _, ...usage } = event
        await deps.recordUsage({ taskId: task.id, stage: 'work', usage, ok: true })
        tokens += usage.inputTokens + usage.outputTokens + usage.cachedTokens
        turns += 1
        if (tokens > task.budget.tokens || turns > task.budget.turns) return { type: 'budgetExceeded' }
      }
      if (event.type === 'done' || event.type === 'error' || event.type === 'approvalRequired') return event
    }
    return { type: 'ended' }
  }

  const remaining = (): Budget => ({
    tokens: Math.max(0, task.budget.tokens - tokens),
    turns: Math.max(0, task.budget.turns - turns),
    subagents: task.budget.subagents,
  })
  const start = () => deps.runtime.start({ ...input, budget: remaining() }, tools)
  const finish = (ok: boolean, result: JsonObject, reason?: string): ExecutionResult => ({
    ok,
    ...(reason ? { reason } : {}),
    actions,
    knowledgeUsed: [...new Set([...input.knowledge.map((entry) => entry.id), ...lookedUp])],
    result,
    turns,
    tokens,
  })

  let stream = start()
  for (;;) {
    const stop = await consume(stream)
    if (stop.type === 'done')
      return finish(stop.ok, stop.result, stop.ok ? undefined : 'AGENT_REPORTED_FAILURE')
    if (stop.type === 'budgetExceeded') return finish(false, {}, 'BUDGET_EXCEEDED')
    if (stop.type === 'ended') return finish(false, {}, 'STREAM_ENDED_EARLY')
    if (stop.type === 'approvalRequired') {
      await deps.onPause(task)
      await deps.awaitDecision(stop.approvalId)
      await deps.onResume(task)
      stream = deps.runtime.resume(stop.resumeToken, tools)
      continue
    }
    if (stop.code === 'BUDGET_EXCEEDED') return finish(false, {}, 'BUDGET_EXCEEDED')
    const seen = (errorCounts[stop.code] ?? 0) + 1
    errorCounts = { ...errorCounts, [stop.code]: seen }
    if (!stop.transient || seen >= 2) return finish(false, {}, `RUNTIME_ERROR:${stop.code}`)
    if (attempts >= deps.maxAttempts) return finish(false, {}, 'RETRY_LIMIT')
    attempts += 1
    await deps.clock.sleep(deps.retryDelayMs)
    stream = start()
  }
}
