import type { ActionType, JsonObject, Task } from '@crewdesk/core'
import { expect, test } from 'vitest'
import { type CloseDeps, closeTask } from './close.ts'

const task: Task = {
  id: 't1',
  requester: 'u1',
  channel: 'c',
  thread: 'th',
  body: '',
  domain: 'deploy',
  taskType: 'deploy.release',
  risk: 'high',
  urgency: 'normal',
  status: 'running',
  budget: { tokens: 1, turns: 1, subagents: 0 },
  createdAt: 0,
}
const release: ActionType = {
  id: 'deployer.release',
  system: 'deployer',
  action: 'release',
  domain: 'deploy',
  reversible: false,
  owner: 'u1',
  approvalLevel: 'always',
  promoteAfter: 3,
  conditionFields: ['env'],
  verify: { resource: 'releases', match: ['svc', 'ver', 'env'] },
}

const run = async (params: JsonObject, rows: JsonObject[]) => {
  const queries: unknown[] = []
  const incidents: unknown[] = []
  const usage = { model: 'm', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
  const deps: CloseDeps = {
    channel: { poll: async () => [], send: async () => {} },
    model: {
      classify: async () => ({ classification: null, confidence: 1, usage }),
      reply: async () => ({ text: 'ok', usage }),
    },
    store: { append: async () => {}, put: async () => {}, get: async () => null, list: async () => [] },
    clock: { now: () => 0, sleep: async () => {} },
    systems: {
      query: async (query) => {
        queries.push(query)
        return { ok: true, value: rows }
      },
      execute: async () => ({ ok: true, value: {} }),
      changes: async () => [],
    },
    actionTypes: () => [release],
    replyModel: 'small',
    recordUsage: async () => {},
    reportIncident: async (action) => void incidents.push(action),
    markUsedOk: async () => {},
  }
  const action = { system: 'deployer', action: 'release', params }
  const closed = await closeTask(
    deps,
    { task, agent: 'agent-deploy', model: 'm', knowledge: [] },
    {
      ok: true,
      actions: [{ action, result: { ok: true, value: {} } }],
      knowledgeUsed: [],
      result: {},
      turns: 1,
      tokens: 1,
    },
  )
  return { closed, queries, incidents }
}

test('an action is verified by querying the system with every match field', async () => {
  const params = { svc: 's', ver: 'v1', env: 'S' }
  const { closed, queries } = await run(params, [params])
  expect(closed.status).toBe('done')
  expect(queries).toEqual([{ system: 'deployer', resource: 'releases', where: params }])
})

test('a missing match field fails verification without querying, and counts as an incident', async () => {
  const { closed, queries, incidents } = await run({ svc: 's', env: 'S' }, [{ svc: 's', env: 'S' }])
  expect(closed.status).toBe('escalated')
  expect(queries).toEqual([])
  expect(incidents).toHaveLength(1)
})

test('no matching row fails verification', async () => {
  expect((await run({ svc: 's', ver: 'v1', env: 'S' }, [])).closed.status).toBe('escalated')
})
