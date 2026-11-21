import type {
  ClockPort,
  DomainAction,
  DomainResult,
  DomainSystemPort,
  Json,
  JsonObject,
  KnowledgeEntry,
  RunRequest,
  RuntimeEvent,
  RuntimePort,
  Task,
  ToolHost,
  ToolResult,
  UsageReport,
} from '@crewdesk/core'

export type ExecutionDeps = {
  runtime: RuntimePort
  systems: DomainSystemPort
  clock: ClockPort
  lookup(input: JsonObject, task: Task): Promise<KnowledgeEntry[]>
  recordUsage(report: UsageReport): Promise<void>
  retryDelayMs: number
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
        const key = JSON.stringify(request)
        const prior = actions.find((done) => done.result.ok && JSON.stringify(done.action) === key)
        if (prior) return toToolResult(prior.result)
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

  const request: RunRequest = { ...input, budget: task.budget }
  const finish = (ok: boolean, result: JsonObject, reason?: string): ExecutionResult => ({
    ok,
    ...(reason ? { reason } : {}),
    actions,
    knowledgeUsed: [...new Set([...input.knowledge.map((entry) => entry.id), ...lookedUp])],
    result,
    turns,
    tokens,
  })

  for (;;) {
    const stop = await consume(deps.runtime.start(request, tools))
    if (stop.type === 'done')
      return finish(stop.ok, stop.result, stop.ok ? undefined : 'AGENT_REPORTED_FAILURE')
    if (stop.type === 'budgetExceeded') return finish(false, {}, 'BUDGET_EXCEEDED')
    if (stop.type === 'ended') return finish(false, {}, 'STREAM_ENDED_EARLY')
    if (stop.type === 'approvalRequired') return finish(false, {}, 'APPROVAL_NOT_SUPPORTED')
    const seen = (errorCounts[stop.code] ?? 0) + 1
    errorCounts = { ...errorCounts, [stop.code]: seen }
    if (!stop.transient || seen >= 2) return finish(false, {}, `RUNTIME_ERROR:${stop.code}`)
    await deps.clock.sleep(deps.retryDelayMs)
  }
}
