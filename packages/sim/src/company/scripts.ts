import type { JsonObject, KnowledgeEntry, RunRequest, ToolResult } from '@crewdesk/core'
import type { Script, ScriptEnd, ScriptStep } from '../dummies/runtime.ts'
import { systemAliases } from './data.ts'

type Steps<T> = Generator<ScriptStep, T, ToolResult>

const fail = (text: string, error = 'UNRESOLVED'): ScriptEnd => ({ ok: false, text, result: { error } })

const end = (result: ToolResult): ScriptEnd =>
  result.status === 'ok'
    ? { ok: true, text: '처리를 마쳤습니다.', result: {} }
    : fail('시스템이 요청을 거부했습니다.', result.status === 'error' ? result.code : 'PAUSED')

const execute = (system: string, action: string, params: JsonObject): ScriptStep => ({
  tool: 'domain.execute',
  input: { system, action, params },
})

const isEntry = (value: unknown): value is KnowledgeEntry =>
  typeof value === 'object' && value !== null && 'id' in value && 'data' in value

const entriesOf = (result: ToolResult): KnowledgeEntry[] => {
  if (result.status !== 'ok' || typeof result.output !== 'object' || result.output === null) return []
  const entries = (result.output as JsonObject).entries
  return Array.isArray(entries) ? entries.filter(isEntry) : []
}

const firstRow = (result: ToolResult): JsonObject | undefined => {
  if (result.status !== 'ok' || !Array.isArray(result.output)) return undefined
  const row = result.output[0]
  return typeof row === 'object' && row !== null && !Array.isArray(row) ? row : undefined
}

const aliasIn = (entry: KnowledgeEntry, body: string) =>
  Array.isArray(entry.data.aliases) &&
  entry.data.aliases.some((alias) => typeof alias === 'string' && body.includes(alias))

function* resolve(
  request: RunRequest,
  concept: string,
  matches: (entry: KnowledgeEntry) => boolean,
  lookup: JsonObject,
  guess: string,
): Steps<string> {
  const wanted = (entry: KnowledgeEntry) => entry.data.concept === concept && matches(entry)
  const local = request.knowledge.find(wanted)
  if (local) return String(local.data.value)
  const found = yield { tool: 'knowledge.lookup', input: { concept, ...lookup } }
  const hit = entriesOf(found).find(wanted)
  return hit ? String(hit.data.value) : guess
}

function* accessGrant(request: RunRequest): Steps<ScriptEnd> {
  const { body } = request.task
  const sys = Object.entries(systemAliases).find(([alias]) => body.includes(alias))?.[1]
  const name = /(\S+)님/.exec(body)?.[1]
  if (!sys || !name) return fail('요청을 해석하지 못했습니다.')
  const role = yield* resolve(
    request,
    'role',
    (entry) => entry.data.scope === sys && aliasIn(entry, body),
    { text: body, scope: sys },
    'ADMIN',
  )
  const account = firstRow(
    yield { tool: 'domain.query', input: { system: 'iam', resource: 'accounts', where: { name } } },
  )
  if (typeof account?.uid !== 'string') return fail('대상 계정을 찾지 못했습니다.', 'NOT_FOUND')
  return end(yield execute('iam', 'grant', { uid: account.uid, sys, role_cd: role }))
}

function* deployRelease(request: RunRequest): Steps<ScriptEnd> {
  const { body } = request.task
  const svc = /[a-z]+-[a-z]+/.exec(body)?.[0]
  const ver = /v\d+\.\d+\.\d+/.exec(body)?.[0]
  if (!svc || !ver) return fail('요청을 해석하지 못했습니다.')
  const env = yield* resolve(request, 'env', (entry) => aliasIn(entry, body), { text: body }, 'prod')
  const rule = request.knowledge.find((entry) => entry.kind === 'rule' && entry.data.before === env)
  if (typeof rule?.data.requires === 'string') {
    const staged = yield execute('deployer', 'release', { svc, ver, env: rule.data.requires })
    if (staged.status !== 'ok') return end(staged)
  }
  return end(yield execute('deployer', 'release', { svc, ver, env }))
}

function* incidentOpen(request: RunRequest): Steps<ScriptEnd> {
  const { body } = request.task
  const svc = /[a-z]+-[a-z]+/.exec(body)?.[0]
  if (!svc) return fail('요청을 해석하지 못했습니다.')
  const sev = yield* resolve(request, 'severity', (entry) => aliasIn(entry, body), { text: body }, 'high')
  const service = firstRow(
    yield { tool: 'domain.query', input: { system: 'deployer', resource: 'services', where: { svc } } },
  )
  if (typeof service?.owner !== 'string') return fail('서비스를 찾지 못했습니다.', 'NOT_FOUND')
  const owner = service.owner
  const grp = yield* resolve(
    request,
    'group',
    (entry) => entry.data.key === owner,
    { key: owner },
    `${owner}-oncall`,
  )
  return end(yield execute('incident', 'open', { svc, sev, grp }))
}

const scripts: Record<string, Script> = {
  'access.grant': accessGrant,
  'deploy.release': deployRelease,
  'incident.open': incidentOpen,
}

export const companyScript: Script = (request) => {
  const script = scripts[request.task.taskType]
  if (script) return script(request)
  // biome-ignore lint/correctness/useYield: a script with no tool calls still has to be a generator
  return (function* (): Steps<ScriptEnd> {
    return fail('담당하지 않는 업무 유형입니다.', 'UNKNOWN_TASK_TYPE')
  })()
}
