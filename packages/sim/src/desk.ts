import type { Domain, InboundMessage, KnowledgeEntry, QueuePort, StorePort, Task } from '@crewdesk/core'
import { handleMessage, type IntakeDeps, threadKey } from '@crewdesk/intake'
import type { Placement } from '@crewdesk/ops'
import { type CloseDeps, closeTask, type ExecutionDeps, executeTask } from '@crewdesk/runtime'

export type DeskDeps = {
  intake: IntakeDeps
  execution: Omit<ExecutionDeps, 'onPause' | 'onResume'>
  close: CloseDeps
  store: StorePort
  queueFor(domain: Domain): QueuePort<Task>
  knowledgeFor(task: Task): Promise<KnowledgeEntry[]>
  workModel(task: Task): string
  place(task: Task): Placement
  onPlaced(task: Task, seat: string): void
  onFinished(task: Task): void
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
  let exclusive: ReadonlySet<string> = new Set()
  let parked: Record<string, Task[]> = {}
  let wakeAt: Record<string, number> = {}

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
        knowledge: await deps.knowledgeFor(task),
      }
      const execution = await executeTask(
        {
          ...deps.execution,
          onPause: async (paused) => {
            await setStatus(paused, 'awaitingApproval')
            release(paused)
          },
          onResume: async (resumed) => {
            if (exclusive.has(resumed.id)) await acquire(resumed)
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
      exclusive = new Set([...exclusive].filter((taskId) => taskId !== task.id))
      active = active.filter((item) => item.taskId !== task.id)
      deps.onFinished(task)
    }
  }

  const park = (task: Task, until: number) => {
    parked = { ...parked, [task.domain]: [...(parked[task.domain] ?? []), task] }
    return until
  }

  const run = (task: Task, seat: string) => {
    deps.onPlaced(task, seat)
    void work(task)
    return null
  }

  const start = async (task: Task) => {
    const placement = deps.place(task)
    if (placement.kind === 'wait') return park(task, placement.until)
    if (!placement.exclusive) return run(task, placement.seat)
    exclusive = new Set([...exclusive, task.id])
    await acquire(task)
    const current = deps.place(task)
    if (current.kind === 'run' && current.seat === placement.seat) return run(task, current.seat)
    release(task)
    exclusive = new Set([...exclusive].filter((taskId) => taskId !== task.id))
    return current.kind === 'wait' ? park(task, current.until) : run(task, current.seat)
  }

  const wakeLater = (domain: Domain, until: number) => {
    if (wakeAt[domain] !== undefined && wakeAt[domain] <= until) return
    wakeAt = { ...wakeAt, [domain]: until }
    const { clock } = deps.intake
    void clock
      .sleep(until - clock.now())
      .then(() => {
        if (wakeAt[domain] !== until) return
        wakeAt = Object.fromEntries(Object.entries(wakeAt).filter(([other]) => other !== domain))
        return drain(domain)
      })
      .catch(deps.onError)
  }

  const drain = async (domain: Domain) => {
    if (draining.has(domain)) return
    draining = new Set([...draining, domain])
    try {
      const resting = wakeAt[domain] !== undefined
      const waiting = resting ? [] : (parked[domain] ?? [])
      if (!resting) parked = { ...parked, [domain]: [] }
      let until: number | null = null
      for (const task of waiting) until = (await start(task)) ?? until
      for (
        let task = await deps.queueFor(domain).dequeue();
        task;
        task = await deps.queueFor(domain).dequeue()
      ) {
        until = (await start(task)) ?? until
      }
      if (until !== null) wakeLater(domain, until)
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
