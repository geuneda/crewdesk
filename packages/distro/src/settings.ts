import type { Budget, JsonObject, Risk, Seat, Stage } from '@crewdesk/core'

export type Settings = {
  promptVersion: string
  routes: { stage: Stage; risk?: Risk; model: string }[]
  intakeStrongModel: string
  budget: Budget
  seats: Seat[]
  tools: { codeMode: boolean; caching: boolean }
  batchEveryHours: number
  staleAfterDays: number
}

const stages = ['intake', 'work', 'close', 'batch', 'eval']
const risks = ['low', 'medium', 'high']

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = (path: string, expected: string): never => {
  throw new Error(`settings.${path} must be ${expected}`)
}

const text = (value: unknown, path: string): string =>
  typeof value === 'string' && value !== '' ? value : fail(path, 'a non-empty string')

const positive = (value: unknown, path: string): number =>
  typeof value === 'number' && value > 0 ? value : fail(path, 'a positive number')

const count = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fail(path, 'a whole number')

const flag = (value: unknown, path: string): boolean =>
  typeof value === 'boolean' ? value : fail(path, 'true or false')

const oneOf = <T extends string>(value: unknown, allowed: string[], path: string): T =>
  typeof value === 'string' && allowed.includes(value)
    ? (value as T)
    : fail(path, `one of ${allowed.join(', ')}`)

const list = (value: unknown, path: string): JsonObject[] =>
  Array.isArray(value) && value.every(isObject) ? (value as JsonObject[]) : fail(path, 'a list of mappings')

const part = (value: unknown, path: string): JsonObject => (isObject(value) ? value : fail(path, 'a mapping'))

export const toSettings = (raw: unknown): Settings => {
  const root = part(raw, '(root)')
  const budget = part(root.budget, 'budget')
  const tools = part(root.tools, 'tools')
  const seats = list(root.seats, 'seats').map((seat, index): Seat => {
    const path = `seats[${index}]`
    const kind = oneOf<Seat['kind']>(seat.kind, ['metered', 'quota'], `${path}.kind`)
    const windows = seat.windows === undefined ? [] : list(seat.windows, `${path}.windows`)
    if (kind === 'quota' && windows.length === 0) fail(`${path}.windows`, 'a non-empty list for a quota seat')
    return {
      id: text(seat.id, `${path}.id`),
      agent: text(seat.agent, `${path}.agent`),
      kind,
      ...(kind === 'quota'
        ? {
            windows: windows.map((window, at) => ({
              lengthMs: positive(window.lengthMs, `${path}.windows[${at}].lengthMs`),
              limit: positive(window.limit, `${path}.windows[${at}].limit`),
            })),
          }
        : {}),
    }
  })
  return {
    promptVersion: text(root.promptVersion, 'promptVersion'),
    routes: list(root.routes, 'routes').map((route, index) => ({
      stage: oneOf<Stage>(route.stage, stages, `routes[${index}].stage`),
      ...(route.risk === undefined ? {} : { risk: oneOf<Risk>(route.risk, risks, `routes[${index}].risk`) }),
      model: text(route.model, `routes[${index}].model`),
    })),
    intakeStrongModel: text(root.intakeStrongModel, 'intakeStrongModel'),
    budget: {
      tokens: positive(budget.tokens, 'budget.tokens'),
      turns: positive(budget.turns, 'budget.turns'),
      subagents: count(budget.subagents, 'budget.subagents'),
    },
    seats,
    tools: {
      codeMode: flag(tools.codeMode, 'tools.codeMode'),
      caching: flag(tools.caching, 'tools.caching'),
    },
    batchEveryHours: positive(root.batchEveryHours, 'batchEveryHours'),
    staleAfterDays: positive(root.staleAfterDays, 'staleAfterDays'),
  }
}
