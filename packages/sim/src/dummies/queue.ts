import type { Json, QueuePort } from '@crewdesk/core'

export const createMemoryQueue = <T extends Json>(): QueuePort<T> => {
  let items: { item: T; priority: number; seq: number }[] = []
  let seq = 0
  return {
    enqueue: async (item, priority = 0) => {
      items = [...items, { item, priority, seq: seq++ }].sort(
        (a, b) => b.priority - a.priority || a.seq - b.seq,
      )
    },
    dequeue: async () => {
      const [head, ...rest] = items
      items = rest
      return head ? head.item : null
    },
    size: async () => items.length,
  }
}
