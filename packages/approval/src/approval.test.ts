import type { ActionType, ApprovalRecord, DomainAction, JsonObject, Task } from '@crewdesk/core'
import { expect, test } from 'vitest'
import { createApprovalDesk, type PendingApproval } from './desk.ts'
import { conditionKeyOf, levelOf, proposePromotions } from './levels.ts'

const grant: ActionType = {
  id: 'iam.grant',
  system: 'iam',
  action: 'grant',
  domain: 'access',
  reversible: true,
  owner: 'lead-access',
  approvalLevel: 'always',
  promoteAfter: 2,
  conditionFields: ['sys', 'role_cd'],
}
const release: ActionType = {
  ...grant,
  id: 'deployer.release',
  system: 'deployer',
  action: 'release',
  domain: 'deploy',
  reversible: false,
  owner: 'lead-deploy',
  conditionFields: ['env'],
}
const task: Task = {
  id: 't1',
  requester: 'u1',
  channel: 'c',
  thread: 'th',
  body: '',
  domain: 'access',
  taskType: 'access.grant',
  risk: 'medium',
  urgency: 'normal',
  status: 'running',
  budget: { tokens: 1, turns: 1, subagents: 0 },
  createdAt: 0,
}
const action = { system: 'iam', action: 'grant', params: { uid: 'u9', sys: 'deployer', role_cd: 'DP' } }
const deploy = { system: 'deployer', action: 'release', params: { svc: 's', ver: 'v1', env: 'P' } }
const key = 'sys=deployer&role_cd=DP'

const setup = () => {
  let now = 0
  const opened: PendingApproval[] = []
  const stored: Record<string, JsonObject[]> = {}
  const notified: string[] = []
  const desk = createApprovalDesk({
    store: {
      append: async (kind, record) => {
        stored[kind] = [...(stored[kind] ?? []), record]
      },
      put: async () => {},
      get: async () => null,
      list: async () => [],
    },
    clock: { now: () => now, sleep: async () => {} },
    actionTypes: () => [grant, release],
    approverFor: (type) => type.owner,
    roleOf: () => 'member',
    onPending: (pending) => void opened.push(pending),
    notify: async (approver) => void notified.push(approver),
  })
  const tick = () => {
    now += 1000
  }
  const approveNext = async (
    taskId: string,
    what: DomainAction = action,
    domain: Task['domain'] = 'access',
  ) => {
    tick()
    const permit = await desk.authorize({ ...task, id: taskId, domain }, what)
    if (permit.status !== 'pending') return permit.status
    const pending = opened.find((item) => item.id === permit.approvalId)
    await desk.decide(permit.approvalId, { approver: pending?.approver ?? '', decision: 'approved' })
    return 'approved'
  }
  const approveRule = async () => {
    tick()
    const proposals = desk.proposePromotions()
    for (const item of desk.pending())
      await desk.decide(item.id, { approver: item.approver, decision: 'approved' })
    return proposals
  }
  return { desk, opened, stored, notified, approveNext, approveRule, tick }
}

test('the condition key uses only the configured fields', () => {
  expect(conditionKeyOf(grant, action.params)).toBe(key)
})

test('an unknown action or another domain is denied in code', async () => {
  const { desk } = setup()
  expect(await desk.authorize(task, { system: 'iam', action: 'drop', params: {} })).toMatchObject({
    status: 'denied',
    code: 'ACTION_NOT_PERMITTED',
  })
  expect(await desk.authorize({ ...task, domain: 'incident' }, action)).toMatchObject({ status: 'denied' })
})

test('an action waits for its approver and only that approver can decide', async () => {
  const { desk, opened } = setup()
  const permit = await desk.authorize(task, action)
  if (permit.status !== 'pending') throw new Error('expected pending')
  expect(await desk.authorize(task, action)).toEqual(permit)
  expect(opened).toHaveLength(1)
  await expect(desk.decide(permit.approvalId, { approver: 'someone', decision: 'approved' })).rejects.toThrow(
    /may not decide/,
  )
  const waiting = desk.awaitDecision(permit.approvalId)
  await desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'approved' })
  await waiting
  expect(await desk.authorize(task, action)).toEqual({ status: 'allow' })
})

test('unmodified approvals in a row promote one level at a time once the owner approves the rule', async () => {
  const { desk, approveNext, approveRule, notified, stored } = setup()
  expect(await approveNext('a1')).toBe('approved')
  expect(desk.proposePromotions()).toEqual([])
  expect(await approveNext('a2')).toBe('approved')
  expect(await approveRule()).toEqual([
    { actionType: 'iam.grant', conditionKey: key, from: 'always', to: 'recommend' },
  ])
  expect(desk.rules()).toEqual([{ actionType: 'iam.grant', conditionKey: key, level: 'recommend' }])
  await approveNext('a3')
  await approveNext('a4')
  await approveRule()
  expect(desk.rules()[0]?.level).toBe('notify')
  expect(await approveNext('a5')).toBe('allow')
  expect(await approveNext('a6')).toBe('allow')
  expect(notified).toEqual(['lead-access', 'lead-access'])
  await approveRule()
  expect(desk.rules()[0]?.level).toBe('auto')
  expect(stored.ruleChange?.map((change) => change.cause)).toEqual(['promotion', 'promotion', 'promotion'])
})

test('an irreversible action never goes past recommend', async () => {
  const { desk, approveNext, approveRule } = setup()
  for (const id of ['d1', 'd2']) await approveNext(id, deploy, 'deploy')
  await approveRule()
  expect(desk.rules()[0]?.level).toBe('recommend')
  for (const id of ['d3', 'd4', 'd5', 'd6']) expect(await approveNext(id, deploy, 'deploy')).toBe('approved')
  expect(await approveRule()).toEqual([])
  expect(
    levelOf(release, 'env=P', [{ actionType: 'deployer.release', conditionKey: 'env=P', level: 'auto' }]),
  ).toBe('recommend')
})

test('one rejection lowers the rule by one level and denies the action', async () => {
  const { desk, approveNext, approveRule, tick, stored } = setup()
  for (const id of ['a1', 'a2']) await approveNext(id)
  await approveRule()
  for (const id of ['a3', 'a4']) await approveNext(id)
  await approveRule()
  expect(desk.rules()[0]?.level).toBe('notify')
  await desk.reportIncident(action)
  expect(desk.rules()[0]?.level).toBe('recommend')
  tick()
  const permit = await desk.authorize({ ...task, id: 'a5' }, action)
  if (permit.status !== 'pending') throw new Error('expected pending')
  await desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'rejected', reason: 'no' })
  expect(desk.rules()[0]?.level).toBe('always')
  expect(await desk.authorize({ ...task, id: 'a5' }, action)).toMatchObject({
    status: 'denied',
    code: 'APPROVAL_REJECTED',
  })
  expect(stored.ruleChange?.map((change) => change.cause)).toEqual([
    'promotion',
    'promotion',
    'incident',
    'rejection',
  ])
})

test('a modified approval or a rejected rule proposal restarts the streak', () => {
  const record = (decidedAt: number, modified = false): ApprovalRecord => ({
    actionType: 'iam.grant',
    conditionKey: key,
    requesterRole: 'member',
    approver: 'lead-access',
    decision: 'approved',
    modified,
    decidedInMs: 1,
    decidedAt,
    level: 'always',
  })
  expect(proposePromotions([grant], [], [record(1), record(2, true), record(3)], () => -1)).toEqual([])
  expect(proposePromotions([grant], [], [record(1), record(2), record(3)], () => 2)).toEqual([])
  expect(proposePromotions([grant], [], [record(1, true), record(2), record(3)], () => -1)).toHaveLength(1)
})
