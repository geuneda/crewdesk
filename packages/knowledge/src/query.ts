import { createHash } from 'node:crypto'
import type { Json, JsonObject, KnowledgeEntry } from '@crewdesk/core'
import type { KnowledgeBase } from './schema.ts'

const canonical = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) => {
        const item = value[key]
        return item === undefined ? [] : [[key, canonical(item)]]
      }),
  )
}

export const hashOf = (value: Json): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
    .slice(0, 16)

export const entryHash = (entry: KnowledgeEntry): string =>
  hashOf({ kind: entry.kind, confidence: entry.confidence, taskTypes: entry.taskTypes, data: entry.data })

export const fragmentFor = (kb: KnowledgeBase, taskType: string): KnowledgeEntry[] =>
  kb.entries.filter((entry) => entry.taskTypes.includes(taskType))

const hasAlias = (entry: KnowledgeEntry, body: string) =>
  !Array.isArray(entry.data.aliases) ||
  entry.data.aliases.some((alias) => typeof alias === 'string' && body.includes(alias))

export const lookup = (kb: KnowledgeBase, query: JsonObject): KnowledgeEntry[] =>
  kb.entries.filter(
    (entry) =>
      (query.id === undefined || entry.id === query.id) &&
      (query.concept === undefined || entry.data.concept === query.concept) &&
      (query.key === undefined || entry.data.key === query.key) &&
      (query.scope === undefined || entry.data.scope === query.scope) &&
      (typeof query.text !== 'string' || hasAlias(entry, query.text)),
  )

export const patchEntry = (kb: KnowledgeBase, entryId: string, data: JsonObject): KnowledgeBase => ({
  entries: kb.entries.map((entry) =>
    entry.id === entryId ? { ...entry, data: { ...entry.data, ...data } } : entry,
  ),
})
