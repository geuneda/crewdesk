import type { ActionType, CatalogItem, Domain, JsonObject, KnowledgeEntry } from '@crewdesk/core'
import { parse } from 'yaml'

export type KnowledgeBase = { entries: KnowledgeEntry[] }
export type KnowledgeSource = { name: string; text: string }

const kinds = ['entity', 'relation', 'mapping', 'rule']
const confidences = ['confirmed', 'assumed']
const domains = ['access', 'deploy', 'incident']
const risks = ['low', 'medium', 'high']
const levels = ['always', 'recommend', 'notify', 'auto']

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (holder: JsonObject, key: string, where: string): string => {
  const value = holder[key]
  if (typeof value !== 'string' || value === '')
    throw new Error(`${where}: ${key} must be a non-empty string`)
  return value
}

const oneOf = <T extends string>(holder: JsonObject, key: string, allowed: string[], where: string): T => {
  const value = text(holder, key, where)
  if (!allowed.includes(value)) throw new Error(`${where}: ${key} must be one of ${allowed.join(', ')}`)
  return value as T
}

const texts = (holder: JsonObject, key: string, where: string): string[] => {
  const value = holder[key] ?? []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${where}: ${key} must be a list of strings`)
  }
  return value as string[]
}

const optional = (holder: JsonObject, key: string, where: string) =>
  holder[key] === undefined ? {} : { [key]: text(holder, key, where) }

const toEntry = (raw: unknown, source: string): KnowledgeEntry => {
  if (!isObject(raw)) throw new Error(`${source}: every entry must be a mapping`)
  const where = `${source}: ${typeof raw.id === 'string' ? raw.id : '(no id)'}`
  if (!isObject(raw.data)) throw new Error(`${where}: data must be a mapping`)
  return {
    id: text(raw, 'id', where),
    kind: oneOf(raw, 'kind', kinds, where),
    owner: text(raw, 'owner', where),
    confidence: oneOf(raw, 'confidence', confidences, where),
    taskTypes: texts(raw, 'taskTypes', where),
    data: raw.data,
    ...optional(raw, 'evidence', where),
    ...optional(raw, 'lastVerifiedAt', where),
  }
}

const verifyOf = (raw: unknown, where: string) => {
  if (!isObject(raw)) throw new Error(`${where}: verify must be a mapping`)
  const match = texts(raw, 'match', where)
  if (match.length === 0) throw new Error(`${where}: verify.match must list at least one field`)
  return { resource: text(raw, 'resource', where), match }
}

const typed = (kb: KnowledgeBase, type: string) =>
  kb.entries.filter((entry) => entry.kind === 'entity' && entry.data.type === type)

export const catalogOf = (kb: KnowledgeBase): CatalogItem[] =>
  typed(kb, 'TaskType').map(({ id, data }) => ({
    domain: oneOf<Domain>(data, 'domain', domains, id),
    taskType: text(data, 'taskType', id),
    description: text(data, 'description', id),
    aliases: texts(data, 'aliases', id),
    risk: oneOf(data, 'risk', risks, id),
  }))

export const actionTypesOf = (kb: KnowledgeBase): ActionType[] =>
  typed(kb, 'ActionType').map(({ id, owner, data }) => {
    const system = text(data, 'system', id)
    const action = text(data, 'action', id)
    if (typeof data.reversible !== 'boolean') throw new Error(`${id}: reversible must be true or false`)
    if (typeof data.promoteAfter !== 'number' || data.promoteAfter < 1) {
      throw new Error(`${id}: promoteAfter must be a positive number`)
    }
    return {
      id: `${system}.${action}`,
      system,
      action,
      domain: oneOf<Domain>(data, 'domain', domains, id),
      reversible: data.reversible,
      owner,
      approvalLevel: oneOf(data, 'approvalLevel', levels, id),
      promoteAfter: data.promoteAfter,
      conditionFields: texts(data, 'conditionFields', id),
      ...(data.verify === undefined ? {} : { verify: verifyOf(data.verify, id) }),
    }
  })

export const approverOf = (kb: KnowledgeBase, type: ActionType): string => {
  const relation = kb.entries.find(
    (entry) =>
      entry.kind === 'relation' && entry.data.type === 'approves' && entry.data.actionType === type.id,
  )
  return typeof relation?.data.approver === 'string' ? relation.data.approver : type.owner
}

export const parseKnowledge = (sources: KnowledgeSource[]): KnowledgeBase => {
  const entries = sources.flatMap(({ name, text: body }) => {
    const document: unknown = parse(body)
    if (!isObject(document) || !Array.isArray(document.entries)) {
      throw new Error(`${name}: expected a top-level "entries" list`)
    }
    return document.entries.map((raw) => toEntry(raw, name))
  })
  const duplicate = entries.find(
    (entry, index) => entries.findIndex((other) => other.id === entry.id) !== index,
  )
  if (duplicate) throw new Error(`duplicate knowledge entry id: ${duplicate.id}`)
  const kb = { entries }
  catalogOf(kb)
  actionTypesOf(kb)
  return kb
}
