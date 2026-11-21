import type {
  ActionType,
  ChannelPort,
  ClockPort,
  DomainSystemPort,
  ModelPort,
  StorePort,
  Task,
  UsageReport,
} from '@crewdesk/core'
import type { ExecutedAction, ExecutionInput, ExecutionResult } from './execute.ts'

export type CloseDeps = {
  channel: ChannelPort
  model: ModelPort
  store: StorePort
  clock: ClockPort
  systems: DomainSystemPort
  actionTypes(): ActionType[]
  replyModel: string
  recordUsage(report: UsageReport): Promise<void>
}

const verifyAction = async (deps: CloseDeps, { action }: ExecutedAction): Promise<boolean> => {
  const spec = deps
    .actionTypes()
    .find((type) => type.system === action.system && type.action === action.action)
  if (!spec?.verify) return true
  const where = Object.fromEntries(
    spec.verify.match.flatMap((field) => {
      const value = action.params[field]
      return typeof value === 'string' || typeof value === 'number' ? [[field, value]] : []
    }),
  )
  const rows = await deps.systems.query({ system: action.system, resource: spec.verify.resource, where })
  return rows.ok && rows.value.length > 0
}

export const closeTask = async (
  deps: CloseDeps,
  input: ExecutionInput,
  execution: ExecutionResult,
): Promise<Task> => {
  const succeeded = execution.actions.filter((done) => done.result.ok)
  const checks = await Promise.all(succeeded.map((done) => verifyAction(deps, done)))
  const verified = checks.every(Boolean)
  const ok = execution.ok && verified
  const reason = execution.ok && !verified ? 'VERIFICATION_FAILED' : execution.reason
  const task: Task = { ...input.task, status: ok ? 'done' : 'escalated' }
  const reply = await deps.model.reply({
    model: deps.replyModel,
    task,
    outcome: ok ? 'done' : 'escalated',
    facts: { ...execution.result, ...(reason ? { reason } : {}) },
  })
  await deps.recordUsage({ taskId: task.id, stage: 'close', usage: reply.usage, ok: true })
  await deps.channel.send({
    channel: task.channel,
    thread: task.thread,
    body: reply.text,
    at: deps.clock.now(),
  })
  await deps.store.put('task', task.id, task)
  await deps.store.put('trace', task.id, {
    taskId: task.id,
    agent: input.agent,
    model: input.model,
    knowledge: execution.knowledgeUsed,
    actions: execution.actions,
    verified,
    ok,
    ...(reason ? { reason } : {}),
    turns: execution.turns,
    tokens: execution.tokens,
    closedAt: deps.clock.now(),
  })
  return task
}
