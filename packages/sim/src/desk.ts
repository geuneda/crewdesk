import type { Domain, InboundMessage, KnowledgeEntry, QueuePort, StorePort, Task } from '@crewdesk/core'
import { handleMessage, type IntakeDeps } from '@crewdesk/intake'
import { type CloseDeps, closeTask, type ExecutionDeps, executeTask } from '@crewdesk/runtime'

export type DeskDeps = {
  intake: IntakeDeps
  execution: ExecutionDeps
  close: CloseDeps
  store: StorePort
  queueFor(domain: Domain): QueuePort<Task>
  knowledgeFor(task: Task): KnowledgeEntry[]
  workModel(task: Task): string
}

const priority = { low: 0, normal: 1, high: 2 }

export const createDesk = (deps: DeskDeps) => {
  let activeThreads: ReadonlySet<string> = new Set()
  let busy: ReadonlySet<Domain> = new Set()

  const work = async (task: Task) => {
    const running: Task = { ...task, status: 'running' }
    await deps.store.put('task', task.id, running)
    const input = {
      task: running,
      agent: deps.intake.agentFor(task.domain),
      model: deps.workModel(task),
      knowledge: deps.knowledgeFor(task),
    }
    const execution = await executeTask(deps.execution, input)
    await deps.store.put('task', task.id, { ...running, status: 'verifying' })
    await closeTask(deps.close, input, execution)
    activeThreads = new Set([...activeThreads].filter((thread) => thread !== task.thread))
  }

  const drain = async (domain: Domain) => {
    if (busy.has(domain)) return
    busy = new Set([...busy, domain])
    for (
      let task = await deps.queueFor(domain).dequeue();
      task;
      task = await deps.queueFor(domain).dequeue()
    ) {
      await work(task)
    }
    busy = new Set([...busy].filter((other) => other !== domain))
  }

  return {
    onMessage: async (message: InboundMessage): Promise<void> => {
      const task = await handleMessage(deps.intake, message, activeThreads)
      if (!task) return
      activeThreads = new Set([...activeThreads, task.thread])
      const queued: Task = { ...task, status: 'queued' }
      await deps.store.put('task', task.id, queued)
      await deps.queueFor(task.domain).enqueue(queued, priority[task.urgency])
      await drain(task.domain)
    },
  }
}
