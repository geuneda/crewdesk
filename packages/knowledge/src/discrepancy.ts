import {
  type ChangeEvent,
  canonicalJson,
  type DiscrepancyReport,
  type DomainError,
  type DomainQuery,
  type JsonObject,
  type KnowledgeEntry,
} from '@crewdesk/core'
import type { KnowledgeBase } from './schema.ts'

export type Evidence = { query: DomainQuery; field: string; to?: string; changedAt?: number }

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fieldsFrom = (entry: KnowledgeEntry, path: string, value: unknown): string[] =>
  isObject(entry.data.sources)
    ? Object.entries(entry.data.sources)
        .filter(([field, source]) => source === path && entry.data[field] === value)
        .map(([field]) => field)
    : []

const report = (
  entry: KnowledgeEntry,
  field: string,
  observed: string,
  evidence: Evidence,
  rest: Pick<DiscrepancyReport, 'source' | 'reportedAt' | 'taskId'>,
): DiscrepancyReport => ({
  entryId: entry.id,
  expected: `${field}=${String(entry.data[field])}`,
  observed,
  evidence: canonicalJson(evidence),
  ...rest,
})

export const detectDiscrepancies = (
  used: KnowledgeEntry[],
  error: DomainError,
  taskId: string,
  now: number,
): DiscrepancyReport[] => {
  const { system, resource, field, value } = error.detail ?? {}
  if (
    typeof system !== 'string' ||
    typeof resource !== 'string' ||
    typeof field !== 'string' ||
    (typeof value !== 'string' && typeof value !== 'number')
  ) {
    return []
  }
  const path = `${system}/${resource}/${field}`
  return used.flatMap((entry) =>
    fieldsFrom(entry, path, value).map((entryField) =>
      report(
        entry,
        entryField,
        `${error.code}: ${path} has no ${String(value)}`,
        { query: { system, resource, where: { [field]: value } }, field: entryField },
        { source: 'runtime', reportedAt: now, taskId },
      ),
    ),
  )
}

export const reportsFromChange = (
  kb: KnowledgeBase,
  event: ChangeEvent,
  now: number,
): DiscrepancyReport[] => {
  const { system, resource, field, from, to } = event.detail
  if (
    event.kind !== 'codeChange' ||
    typeof system !== 'string' ||
    typeof resource !== 'string' ||
    typeof field !== 'string' ||
    typeof from !== 'string' ||
    typeof to !== 'string'
  ) {
    return []
  }
  const path = `${system}/${resource}/${field}`
  return kb.entries.flatMap((entry) =>
    fieldsFrom(entry, path, from).map((entryField) =>
      report(
        entry,
        entryField,
        `${path} changed ${from} to ${to}`,
        { query: { system, resource, where: { [field]: from } }, field: entryField, to, changedAt: event.at },
        { source: 'systemEvent', reportedAt: now },
      ),
    ),
  )
}

export const parseEvidence = (raw: string): Evidence | null => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed) || !isObject(parsed.query) || typeof parsed.field !== 'string') return null
    const { system, resource, where } = parsed.query
    if (typeof system !== 'string' || typeof resource !== 'string' || !isObject(where)) return null
    return parsed as unknown as Evidence
  } catch {
    return null
  }
}
