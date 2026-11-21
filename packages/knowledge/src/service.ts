import type { ClockPort, JsonObject, KnowledgeEntry, StorePort, Task } from '@crewdesk/core'
import { fragmentFor, lookup } from './query.ts'
import type { KnowledgeBase } from './schema.ts'

export type KnowledgeServiceDeps = {
  kb(): KnowledgeBase
  store: StorePort
  clock: ClockPort
  enabled(): boolean
}

export const createKnowledgeService = (deps: KnowledgeServiceDeps) => {
  const log = (task: Task, via: string, query: JsonObject, entries: KnowledgeEntry[]) =>
    deps.store.append('knowledgeUse', {
      taskId: task.id,
      via,
      query,
      entryIds: entries.map((entry) => entry.id),
      at: deps.clock.now(),
    })

  return {
    fragment: async (task: Task): Promise<KnowledgeEntry[]> => {
      const entries = deps.enabled() ? fragmentFor(deps.kb(), task.taskType) : []
      await log(task, 'fragment', { taskType: task.taskType }, entries)
      return entries
    },
    lookup: async (query: JsonObject, task: Task): Promise<KnowledgeEntry[]> => {
      const entries = deps.enabled() ? lookup(deps.kb(), query) : []
      await log(task, 'lookup', query, entries)
      return entries
    },
  }
}
