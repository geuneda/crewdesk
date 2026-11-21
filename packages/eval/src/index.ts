import type { DomainAction, JsonObject, KnowledgeEntry, StorePort } from '@crewdesk/core'
import { catalogOf, entryHash, fragmentFor, hashOf, type KnowledgeBase, lookup } from '@crewdesk/knowledge'
import type { ExecutedAction } from '@crewdesk/runtime'
import { parse } from 'yaml'

export type Question = { id: string; taskType: string; body: string; expect: DomainAction }

export type EvalKnowledge = {
  fragment: KnowledgeEntry[]
  lookup(query: JsonObject): Promise<KnowledgeEntry[]>
}

export type EvalAgent = (
  question: Question,
  knowledge: EvalKnowledge,
  model: string,
) => Promise<{ actions: ExecutedAction[] }>

export type EvalOptions = {
  questions: Question[]
  kb: KnowledgeBase
  agent: EvalAgent
  cache: StorePort
  promptVersion: string
  model: string
  runs?: number
  force?: boolean
  environment?: string
}

export type QuestionResult = { id: string; pass: boolean; cached: boolean; usedEntryIds: string[] }
export type EvalReport = { results: QuestionResult[]; ran: number; cached: number; accuracy: number }

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseQuestions = (text: string): Question[] => {
  const document: unknown = parse(text)
  if (!isObject(document) || !Array.isArray(document.questions)) {
    throw new Error('expected a top-level "questions" list')
  }
  return document.questions.map((raw, index) => {
    const expect = isObject(raw) ? raw.expect : undefined
    if (
      !isObject(raw) ||
      typeof raw.id !== 'string' ||
      typeof raw.taskType !== 'string' ||
      typeof raw.body !== 'string' ||
      !isObject(expect) ||
      typeof expect.system !== 'string' ||
      typeof expect.action !== 'string' ||
      !isObject(expect.params)
    ) {
      throw new Error(`question ${index + 1} needs id, taskType, body, and expect { system, action, params }`)
    }
    return {
      id: raw.id,
      taskType: raw.taskType,
      body: raw.body,
      expect: { system: expect.system, action: expect.action, params: expect.params },
    }
  })
}

export const gradeLastAction = (expect: DomainAction, actions: ExecutedAction[]): boolean => {
  const last = actions.filter((done) => done.result.ok).at(-1)
  return last !== undefined && hashOf(last.action) === hashOf(expect)
}

const runsOf = (options: EvalOptions): number => {
  const runs = options.runs ?? 1
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive whole number')
  return runs
}

const catalogItemOf = (options: EvalOptions, question: Question) => {
  const item = catalogOf(options.kb).find((candidate) => candidate.taskType === question.taskType)
  if (!item) throw new Error(`question ${question.id} uses an unknown task type ${question.taskType}`)
  return item
}

const cacheKey = (options: EvalOptions, question: Question, lookups: JsonObject[]): string =>
  hashOf({
    question,
    runs: runsOf(options),
    environment: options.environment ?? '',
    catalogItem: catalogItemOf(options, question),
    promptVersion: options.promptVersion,
    model: options.model,
    fragment: fragmentFor(options.kb, question.taskType).map((entry) => [entry.id, entryHash(entry)]),
    lookups: lookups.map((query) => lookup(options.kb, query).map((entry) => [entry.id, entryHash(entry)])),
  })

const runQuestion = async (options: EvalOptions, question: Question) => {
  const fragment = fragmentFor(options.kb, question.taskType)
  const attempts = await Promise.all(
    Array.from({ length: runsOf(options) }, async () => {
      let lookups: JsonObject[] = []
      let found: string[] = []
      const { actions } = await options.agent(
        question,
        {
          fragment,
          lookup: async (query) => {
            const entries = lookup(options.kb, query)
            lookups = [...lookups, query]
            found = [...found, ...entries.map((entry) => entry.id)]
            return entries
          },
        },
        options.model,
      )
      return { pass: gradeLastAction(question.expect, actions), lookups, found }
    }),
  )
  const lookups = attempts
    .flatMap((attempt) => attempt.lookups)
    .filter((query, index, all) => all.findIndex((other) => hashOf(other) === hashOf(query)) === index)
  return {
    pass: attempts.every((attempt) => attempt.pass),
    lookups,
    usedEntryIds: [
      ...new Set([...fragment.map((entry) => entry.id), ...attempts.flatMap((attempt) => attempt.found)]),
    ],
  }
}

export const runEval = async (options: EvalOptions): Promise<EvalReport> => {
  const results = await Promise.all(
    options.questions.map(async (question): Promise<QuestionResult> => {
      const saved = await options.cache.get('evalCache', question.id)
      if (
        !options.force &&
        saved &&
        Array.isArray(saved.lookups) &&
        saved.key === cacheKey(options, question, saved.lookups as JsonObject[])
      ) {
        return {
          id: question.id,
          pass: saved.pass === true,
          cached: true,
          usedEntryIds: saved.usedEntryIds as string[],
        }
      }
      const fresh = await runQuestion(options, question)
      await options.cache.put('evalCache', question.id, {
        key: cacheKey(options, question, fresh.lookups),
        pass: fresh.pass,
        lookups: fresh.lookups,
        usedEntryIds: fresh.usedEntryIds,
      })
      return { id: question.id, pass: fresh.pass, cached: false, usedEntryIds: fresh.usedEntryIds }
    }),
  )
  const cached = results.filter((result) => result.cached).length
  return {
    results,
    ran: results.length - cached,
    cached,
    accuracy: results.length === 0 ? 0 : results.filter((result) => result.pass).length / results.length,
  }
}
