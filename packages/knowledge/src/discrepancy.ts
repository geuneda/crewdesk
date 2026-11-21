import {
  type ChangeEvent,
  canonicalJson,
  type DiscrepancyReport,
  type DomainError,
  type DomainQuery,
  type Json,
  type JsonObject,
  type KnowledgeEntry,
} from '@crewdesk/core'
import type { KnowledgeBase } from './schema.ts'

export type Evidence = {
  query: DomainQuery
  field: string
  column: string
  expected: Json
  to?: string
  changedAt?: number
}

type Scalars = Record<string, string | number>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const scalars = (value: unknown): Scalars =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (pair): pair is [string, string | number] =>
            typeof pair[1] === 'string' || typeof pair[1] === 'number',
        ),
      )
    : {}

const fieldsFrom = (entry: KnowledgeEntry, path: string): string[] =>
  isObject(entry.data.sources)
    ? Object.entries(entry.data.sources)
        .filter(([, source]) => source === path)
        .map(([field]) => field)
    : []

const agrees = (entry: KnowledgeEntry, table: string, where: Scalars): boolean =>
  Object.entries(where).every(([column, value]) =>
    fieldsFrom(entry, `${table}/${column}`).every((field) => entry.data[field] === value),
  )

const report = (
  entry: KnowledgeEntry,
  observed: string,
  evidence: Evidence,
  rest: Pick<DiscrepancyReport, 'source' | 'reportedAt' | 'taskId'>,
): DiscrepancyReport => ({
  entryId: entry.id,
  expected: `${evidence.field}=${String(evidence.expected)}`,
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
  const { system, resource, field: column, value } = error.detail ?? {}
  if (
    typeof system !== 'string' ||
    typeof resource !== 'string' ||
    typeof column !== 'string' ||
    (typeof value !== 'string' && typeof value !== 'number')
  ) {
    return []
  }
  const table = `${system}/${resource}`
  const where = { ...scalars(error.detail?.where), [column]: value }
  return used
    .filter((entry) => agrees(entry, table, where))
    .flatMap((entry) =>
      fieldsFrom(entry, `${table}/${column}`).map((field) =>
        report(
          entry,
          `${error.code}: ${table} has no row with ${canonicalJson(where)}`,
          { query: { system, resource, where }, field, column, expected: value },
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
  const { system, resource, field: column, from, to } = event.detail
  if (
    event.kind !== 'codeChange' ||
    typeof system !== 'string' ||
    typeof resource !== 'string' ||
    typeof column !== 'string' ||
    typeof from !== 'string' ||
    typeof to !== 'string'
  ) {
    return []
  }
  const path = `${system}/${resource}/${column}`
  return kb.entries.flatMap((entry) =>
    fieldsFrom(entry, path)
      .filter((field) => entry.data[field] === from)
      .map((field) =>
        report(
          entry,
          `${path} changed ${from} to ${to}`,
          {
            query: { system, resource, where: { [column]: from } },
            field,
            column,
            expected: from,
            to,
            changedAt: event.at,
          },
          { source: 'systemEvent', reportedAt: now },
        ),
      ),
  )
}

export const parseEvidence = (raw: string): Evidence | null => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !isObject(parsed) ||
      !isObject(parsed.query) ||
      typeof parsed.field !== 'string' ||
      typeof parsed.column !== 'string' ||
      parsed.expected === undefined
    ) {
      return null
    }
    const { system, resource, where } = parsed.query
    if (typeof system !== 'string' || typeof resource !== 'string' || !isObject(where)) return null
    return parsed as unknown as Evidence
  } catch {
    return null
  }
}
