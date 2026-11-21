import type { Domain, InboundMessage, KnowledgeEntry, QueuePort, StorePort, Task } from '@crewdesk/core'
import { handleMessage, type IntakeDeps, threadKey } from '@crewdesk/intake'
import { type CloseDeps, closeTask, type ExecutionDeps, executeTask } from '@crewdesk/runtime'

export type DeskDeps = {
  intake: IntakeDeps
  execution: Omit<ExecutionDeps, 'onPause' | 'onResume'>
  close: CloseDeps
  store: StorePort
  queueFor(domain: Domain): QueuePort<Task>
  knowledgeFor(task: Task): KnowledgeEntry[]
  workModel(task: Task): string
  onError(error: unknown): void
}

type Release = () => void

const priority = { low: 0, normal: 1, high: 2 }

const createLock = () => {
  let tail: Promise<void> = Promise.resolve()
  return (): Promise<Release> => {
    let release: Release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = tail.then(() => release)
    tail = tail.then(() => held)
    return ready
  }
}

export const createDesk = (deps: DeskDeps) => {
  let active: { taskId: string; thread: string }[] = []
  let draining: ReadonlySet<Domain> = new Set()
  let seats: Record<string, () => Promise<Release>> = {}
  let held: Record<string, Release> = {}

  const acquire = async (task: Task) => {
    const seat = seats[task.domain] ?? createLock()
    seats = { ...seats, [task.domain]: seat }
    const granted = await seat()
    held = { ...held, [task.id]: granted }
  }
  const release = (task: Task) => {
    held[task.id]?.()
    held = Object.fromEntries(Object.entries(held).filter(([taskId]) => taskId !== task.id))
  }
  const setStatus = (task: Task, status: Task['status']) =>
    deps.store.put('task', task.id, { ...task, status })

  const work = async (task: Task) => {
    try {
      await setStatus(task, 'running')
      const input = {
        task: { ...task, status: 'running' as const },
        agent: deps.intake.agentFor(task.domain),
        model: deps.workModel(task),
        knowledge: deps.knowledgeFor(task),
      }
      const execution = await executeTask(
        {
          ...deps.execution,
          onPause: async (paused) => {
            await setStatus(paused, 'awaitingApproval')
            release(paused)
          },
          onResume: async (resumed) => {
            await acquire(resumed)
            await setStatus(resumed, 'running')
          },
        },
        input,
      )
      await setStatus(task, 'verifying')
      await closeTask(deps.close, input, execution)
    } catch (error) {
      deps.onError(error)
      await setStatus(task, 'escalated').catch(deps.onError)
    } finally {
      release(task)
      active = active.filter((item) => item.taskId !== task.id)
    }
  }

  const drain = async (domain: Domain) => {
    if (draining.has(domain)) return
    draining = new Set([...draining, domain])
    try {
      for (
        let task = await deps.queueFor(domain).dequeue();
        task;
        task = await deps.queueFor(domain).dequeue()
      ) {
        await acquire(task)
        void work(task)
      }
    } finally {
      draining = new Set([...draining].filter((other) => other !== domain))
    }
  }

  return {
    onMessage: async (message: InboundMessage): Promise<void> => {
      const task = await handleMessage(deps.intake, message, new Set(active.map((item) => item.thread)))
      if (!task) return
      active = [...active, { taskId: task.id, thread: threadKey(task) }]
      const queued: Task = { ...task, status: 'queued' }
      await deps.store.put('task', task.id, queued)
      await deps.queueFor(task.domain).enqueue(queued, priority[task.urgency])
      await drain(task.domain)
    },
  }
}
