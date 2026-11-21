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
const key = 'sys="deployer"&role_cd="DP"'

const setup = (options: { human?: boolean } = {}) => {
  let now = 0
  let failAppend: string | false = false
  let slow: Promise<void> | null = null
  const opened: PendingApproval[] = []
  const stored: Record<string, JsonObject[]> = {}
  const notified: string[] = []
  const desk = createApprovalDesk({
    store: {
      append: async (kind, record) => {
        if (kind === 'ruleChange' && slow) await slow
        if (failAppend === kind) throw new Error('store down')
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
    humanApproval: () => options.human ?? true,
    onPending: (pending) => void opened.push(pending),
    notify: async (approver) => void notified.push(approver),
  })
  const tick = () => {
    now += 1000
  }
  const run = async (
    taskId: string,
    what: DomainAction = action,
    domain: Task['domain'] = 'access',
    ok = true,
  ) => {
    tick()
    const actor = { ...task, id: taskId, domain }
    const permit = await desk.authorize(actor, what)
    if (permit.status === 'denied') return 'denied'
    if (permit.status === 'pending') {
      const pending = opened.find((item) => item.id === permit.approvalId)
      await desk.decide(permit.approvalId, { approver: pending?.approver ?? '', decision: 'approved' })
    }
    await desk.recordExecution(actor, what, ok)
    return permit.status === 'pending' ? 'approved' : 'auto'
  }
  const approveRules = async () => {
    tick()
    const proposals = desk.proposePromotions()
    for (const item of desk.pending()) {
      if (item.kind === 'rule') await desk.decide(item.id, { approver: item.approver, decision: 'approved' })
    }
    return proposals
  }
  const promoteTo = async (level: string) => {
    for (let n = 0; desk.rules()[0]?.level !== level; n += 1) {
      await run(`p${level}${n}`)
      await approveRules()
    }
  }
  return {
    desk,
    opened,
    stored,
    notified,
    run,
    approveRules,
    promoteTo,
    tick,
    breakStore: (broken: boolean, kind = 'approval') => {
      failAppend = broken ? kind : false
    },
    slowRuleChanges: (gate: Promise<void> | null) => {
      slow = gate
    },
  }
}

test('the condition key keeps only the configured fields and their JSON types', () => {
  expect(conditionKeyOf(grant, action.params)).toBe(key)
  expect(conditionKeyOf(grant, { sys: 1, role_cd: '1' })).not.toBe(
    conditionKeyOf(grant, { sys: '1', role_cd: 1 }),
  )
  expect(conditionKeyOf(grant, { sys: 'deployer' })).not.toBe(
    conditionKeyOf(grant, { sys: 'deployer', role_cd: '' }),
  )
})

test('an unknown action or another domain is denied in code, even with human approval off', async () => {
  for (const human of [true, false]) {
    const { desk } = setup({ human })
    expect(await desk.authorize(task, { system: 'iam', action: 'drop', params: {} })).toMatchObject({
      status: 'denied',
      code: 'ACTION_NOT_PERMITTED',
    })
    expect(await desk.authorize({ ...task, domain: 'incident' }, action)).toMatchObject({ status: 'denied' })
  }
  expect(await setup({ human: false }).desk.authorize(task, action)).toEqual({ status: 'allow' })
})

test('an action waits for its approver and only that approver can decide', async () => {
  const { desk, opened, stored } = setup()
  const permit = await desk.authorize(task, action)
  if (permit.status !== 'pending') throw new Error('expected pending')
  expect(await desk.authorize(task, action)).toEqual(permit)
  expect(opened).toHaveLength(1)
  expect(stored.gate).toEqual([expect.objectContaining({ taskId: 't1', human: true, level: 'always' })])
  await expect(desk.decide(permit.approvalId, { approver: 'someone', decision: 'approved' })).rejects.toThrow(
    /may not decide/,
  )
  const waiting = desk.awaitDecision(permit.approvalId)
  await desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'approved' })
  await waiting
  expect(await desk.authorize(task, action)).toEqual({ status: 'allow' })
  desk.forget(task.id)
  expect(await desk.authorize(task, action)).toMatchObject({ status: 'pending' })
})

test('a decision that cannot be saved stays pending and can be decided again', async () => {
  const { desk, breakStore } = setup()
  const permit = await desk.authorize(task, action)
  if (permit.status !== 'pending') throw new Error('expected pending')
  breakStore(true)
  await expect(
    desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'approved' }),
  ).rejects.toThrow(/store down/)
  expect(await desk.authorize(task, action)).toEqual(permit)
  breakStore(false)
  await desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'approved' })
  expect(await desk.authorize(task, action)).toEqual({ status: 'allow' })
})

test('unmodified approvals in a row promote one level at a time once the owner approves the rule', async () => {
  const { desk, run, approveRules, notified, stored } = setup()
  expect(await run('a1')).toBe('approved')
  expect(desk.proposePromotions()).toEqual([])
  expect(await run('a2')).toBe('approved')
  expect(await approveRules()).toEqual([
    { actionType: 'iam.grant', conditionKey: key, from: 'always', to: 'recommend' },
  ])
  expect(desk.rules()).toEqual([{ actionType: 'iam.grant', conditionKey: key, level: 'recommend' }])
  await run('a3')
  await run('a4')
  await approveRules()
  expect(desk.rules()[0]?.level).toBe('notify')
  expect(await run('a5')).toBe('auto')
  expect(await run('a6')).toBe('auto')
  expect(notified).toEqual(['lead-access', 'lead-access'])
  await approveRules()
  expect(desk.rules()[0]?.level).toBe('auto')
  expect(stored.ruleChange?.map((change) => change.cause)).toEqual(['promotion', 'promotion', 'promotion'])
})

test('automatic runs that fail do not count toward the next promotion and send no notice', async () => {
  const { desk, run, approveRules, promoteTo, notified } = setup()
  await promoteTo('notify')
  expect(await run('f1', action, 'access', false)).toBe('auto')
  expect(await run('f2', action, 'access', false)).toBe('auto')
  expect(await approveRules()).toEqual([])
  expect(notified).toEqual([])
  expect(desk.rules()[0]?.level).toBe('notify')
})

test('a call that lacks a condition field always goes to a human', async () => {
  const { desk, promoteTo } = setup()
  await promoteTo('auto')
  const partial = { system: 'iam', action: 'grant', params: { uid: 'u9', sys: 'deployer' } }
  expect(await desk.authorize({ ...task, id: 'x1' }, partial)).toMatchObject({ status: 'pending' })
})

test('an irreversible action never goes past recommend', async () => {
  const { desk, run, approveRules } = setup()
  for (const id of ['d1', 'd2']) await run(id, deploy, 'deploy')
  await approveRules()
  expect(desk.rules()[0]?.level).toBe('recommend')
  for (const id of ['d3', 'd4', 'd5', 'd6']) expect(await run(id, deploy, 'deploy')).toBe('approved')
  expect(await approveRules()).toEqual([])
  expect(
    levelOf(release, 'env="P"', [{ actionType: 'deployer.release', conditionKey: 'env="P"', level: 'auto' }]),
  ).toBe('recommend')
})

test('one rejection or incident lowers the rule by one level', async () => {
  const { desk, promoteTo, tick, stored } = setup()
  await promoteTo('notify')
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

test('a promotion proposal made before a demotion expires instead of overriding it', async () => {
  const { desk, run, promoteTo, tick } = setup()
  await promoteTo('recommend')
  await run('s1')
  await run('s2')
  tick()
  expect(desk.proposePromotions()).toEqual([expect.objectContaining({ from: 'recommend', to: 'notify' })])
  await desk.reportIncident(action)
  expect(desk.rules()[0]?.level).toBe('always')
  for (const item of desk.pending())
    await desk.decide(item.id, { approver: item.approver, decision: 'approved' })
  expect(desk.rules()[0]?.level).toBe('always')
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

test('a promotion approved while a demotion is being saved does not override it', async () => {
  const { desk, run, promoteTo, tick, slowRuleChanges } = setup()
  await promoteTo('recommend')
  await run('s1')
  await run('s2')
  tick()
  desk.proposePromotions()
  let open = () => {}
  slowRuleChanges(
    new Promise<void>((resolve) => {
      open = resolve
    }),
  )
  const demotion = desk.reportIncident(action)
  const promotions = desk
    .pending()
    .map((item) => desk.decide(item.id, { approver: item.approver, decision: 'approved' }))
  open()
  slowRuleChanges(null)
  await Promise.all([demotion, ...promotions])
  expect(desk.rules()[0]?.level).toBe('always')
})

test('a cautious call at auto is recorded and announced as notify', async () => {
  const { desk, promoteTo, notified, stored, tick } = setup()
  await promoteTo('auto')
  notified.length = 0
  tick()
  const actor = { ...task, id: 'c1' }
  expect(await desk.authorize(actor, action, true)).toEqual({ status: 'allow' })
  await desk.recordExecution(actor, action, true)
  expect(stored.gate?.at(-1)).toMatchObject({ taskId: 'c1', level: 'notify', human: false })
  expect(stored.approval?.at(-1)).toMatchObject({ taskId: 'c1', level: 'notify', approver: 'policy' })
  expect(notified).toEqual(['lead-access'])
})

test('a rejection whose demotion could not be saved is not recorded twice on retry', async () => {
  const { desk, promoteTo, breakStore, stored, tick } = setup()
  await promoteTo('recommend')
  tick()
  const permit = await desk.authorize({ ...task, id: 'r1' }, action)
  if (permit.status !== 'pending') throw new Error('expected pending')
  const reject = { approver: 'lead-access', decision: 'rejected' as const }
  breakStore(true, 'ruleChange')
  await expect(desk.decide(permit.approvalId, reject)).rejects.toThrow(/store down/)
  breakStore(false)
  await desk.decide(permit.approvalId, reject)
  expect(stored.approval?.filter((record) => record.taskId === 'r1')).toHaveLength(1)
  expect(desk.rules()[0]?.level).toBe('always')
})

test('a rejection at the lowest level still cancels a promotion proposed before it', async () => {
  const { desk, run, tick } = setup()
  await run('a1')
  await run('a2')
  tick()
  expect(desk.proposePromotions()).toHaveLength(1)
  const permit = await desk.authorize({ ...task, id: 'a3' }, action)
  if (permit.status !== 'pending') throw new Error('expected pending')
  await desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'rejected' })
  for (const item of desk.pending())
    await desk.decide(item.id, { approver: item.approver, decision: 'approved' })
  expect(desk.rules()).toEqual([])
})

test('a half-saved decision can only be finished as the same decision', async () => {
  const { desk, promoteTo, breakStore, tick } = setup()
  await promoteTo('recommend')
  tick()
  const permit = await desk.authorize({ ...task, id: 'r2' }, action)
  if (permit.status !== 'pending') throw new Error('expected pending')
  breakStore(true, 'ruleChange')
  await expect(
    desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'rejected' }),
  ).rejects.toThrow(/store down/)
  breakStore(false)
  await expect(
    desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'approved' }),
  ).rejects.toThrow(/already recorded as rejected/)
  await desk.decide(permit.approvalId, { approver: 'lead-access', decision: 'rejected' })
  expect(await desk.authorize({ ...task, id: 'r2' }, action)).toMatchObject({ status: 'denied' })
})

test('approvals from before an incident do not count toward a later promotion', async () => {
  const { desk, run, tick } = setup()
  await run('a1')
  await run('a2')
  tick()
  await desk.reportIncident(action)
  tick()
  expect(desk.proposePromotions()).toEqual([])
  await run('a3')
  expect(desk.proposePromotions()).toEqual([])
  await run('a4')
  expect(desk.proposePromotions()).toHaveLength(1)
})
