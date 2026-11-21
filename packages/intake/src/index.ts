import type {
  Budget,
  CatalogItem,
  ChannelPort,
  ClockPort,
  Domain,
  InboundMessage,
  ModelPort,
  StorePort,
  Task,
  UsageReport,
} from '@crewdesk/core'

export type IntakeDeps = {
  channel: ChannelPort
  model: ModelPort
  store: StorePort
  clock: ClockPort
  catalog(): CatalogItem[]
  models: { cheap: string; strong: string }
  confidenceThreshold: number
  budget: Budget
  agentFor(domain: Domain): string
  recordUsage(report: UsageReport): Promise<void>
}

export const passesRuleFilter = (message: InboundMessage, activeThreads: ReadonlySet<string>): boolean =>
  message.mentionsAgent || message.isDirect || activeThreads.has(message.thread)

export const handleMessage = async (
  deps: IntakeDeps,
  message: InboundMessage,
  activeThreads: ReadonlySet<string>,
): Promise<Task | null> => {
  if (!passesRuleFilter(message, activeThreads)) return null
  const taskId = `task-${message.id}`
  const classify = async (model: string) => {
    const response = await deps.model.classify({ model, body: message.body, catalog: deps.catalog() })
    await deps.recordUsage({ taskId, stage: 'intake', usage: response.usage, ok: true })
    return response
  }
  const cheap = await classify(deps.models.cheap)
  const { classification } =
    cheap.confidence < deps.confidenceThreshold ? await classify(deps.models.strong) : cheap
  if (!classification) return null
  const task: Task = {
    id: taskId,
    requester: message.sender,
    channel: message.channel,
    thread: message.thread,
    body: message.body,
    ...classification,
    status: 'received',
    budget: deps.budget,
    createdAt: deps.clock.now(),
  }
  await deps.store.put('task', task.id, task)
  await deps.channel.send({
    channel: task.channel,
    thread: task.thread,
    body: `접수했습니다. 담당: ${deps.agentFor(task.domain)} (${task.id})`,
    at: deps.clock.now(),
  })
  return task
}
