import {
  type ActionType,
  type ApprovalLevel,
  type ApprovalRecord,
  type Authorization,
  type ClockPort,
  canonicalJson,
  type DomainAction,
  type StorePort,
  type Task,
} from '@crewdesk/core'
import {
  type ApprovalRule,
  conditionKeyOf,
  demoted,
  hasConditionFields,
  levelOf,
  needsHuman,
  proposePromotions,
  type RuleProposal,
  withRule,
} from './levels.ts'

export type PendingApproval = {
  id: string
  approver: string
  level: ApprovalLevel
  requestedAt: number
} & (
  | {
      kind: 'action'
      taskId: string
      action: DomainAction
      actionType: string
      conditionKey: string
      requesterRole: string
    }
  | { kind: 'rule'; proposal: RuleProposal; basis: number }
)

export type Decision = {
  approver: string
  decision: 'approved' | 'rejected'
  modified?: boolean
  reason?: string
}

export type ApprovalDeskDeps = {
  store: StorePort
  clock: ClockPort
  actionTypes(): ActionType[]
  approverFor(type: ActionType, action: DomainAction): string
  roleOf(person: string): string
  humanApproval(type: ActionType): boolean
  onPending(pending: PendingApproval): void
  notify(approver: string, text: string): Promise<void>
}

const POLICY = 'policy'

type Gate = { id: string; level: ApprovalLevel; conditionKey: string }
const ruleKey = (actionType: string, conditionKey: string) => `${actionType}|${conditionKey}`

export const createApprovalDesk = (deps: ApprovalDeskDeps) => {
  let rules: ApprovalRule[] = []
  let records: ApprovalRecord[] = []
  let pending: PendingApproval[] = []
  let ruleDecidedAt: Record<string, number> = {}
  let seq = 0
  let ruleTail: Promise<unknown> = Promise.resolve()
  const gateOfCall = new Map<string, Map<string, Gate>>()
  const recorded = new Map<string, Decision['decision']>()
  const streakBreaks = new Map<string, number>()
  const breaksOf = (actionType: string, conditionKey: string) =>
    streakBreaks.get(ruleKey(actionType, conditionKey)) ?? 0
  const breakStreak = (actionType: string, conditionKey: string) =>
    streakBreaks.set(ruleKey(actionType, conditionKey), breaksOf(actionType, conditionKey) + 1)
  const decided = new Map<string, 'approved' | 'rejected'>()
  const waiters = new Map<string, (() => void)[]>()
  const deciding = new Set<string>()

  const typeOf = (id: string) => deps.actionTypes().find((type) => type.id === id)
  const typeFor = (task: Task, action: DomainAction) => {
    const type = typeOf(`${action.system}.${action.action}`)
    return type && type.domain === task.domain ? type : undefined
  }
  const levelFor = (type: ActionType, action: DomainAction) =>
    hasConditionFields(type, action.params)
      ? levelOf(type, conditionKeyOf(type, action.params), rules)
      : 'always'

  const record = async (entry: ApprovalRecord) => {
    await deps.store.append('approval', entry)
    records = [...records, entry]
  }

  const markRuleDecided = (actionType: string, conditionKey: string) => {
    ruleDecidedAt = { ...ruleDecidedAt, [ruleKey(actionType, conditionKey)]: deps.clock.now() }
  }

  const setRule = async (rule: ApprovalRule, from: ApprovalLevel, cause: string) => {
    await deps.store.append('ruleChange', { ...rule, from, cause, at: deps.clock.now() })
    rules = withRule(rules, rule)
    markRuleDecided(rule.actionType, rule.conditionKey)
  }

  const inOrder = <T>(change: () => Promise<T>): Promise<T> => {
    const run = ruleTail.then(change)
    ruleTail = run.catch(() => {})
    return run
  }

  const demote = (actionType: string, conditionKey: string, cause: string) =>
    inOrder(async () => {
      const type = typeOf(actionType)
      if (!type) return
      const from = levelOf(type, conditionKey, rules)
      if (demoted(from) !== from) {
        await setRule({ actionType, conditionKey, level: demoted(from) }, from, cause)
      }
    })

  const open = (item: PendingApproval) => {
    pending = [...pending, item]
    deps.onPending(item)
  }

  const settle = async (item: PendingApproval, decision: Decision) => {
    if (item.kind === 'rule') {
      const { actionType, conditionKey, from, to } = item.proposal
      await inOrder(async () => {
        const type = typeOf(actionType)
        const stillValid =
          type !== undefined &&
          levelOf(type, conditionKey, rules) === from &&
          breaksOf(actionType, conditionKey) === item.basis
        if (decision.decision === 'approved' && stillValid) {
          await setRule({ actionType, conditionKey, level: to }, from, 'promotion')
        } else {
          markRuleDecided(actionType, conditionKey)
        }
      })
      return
    }
    const saved = recorded.get(item.id)
    if (saved && saved !== decision.decision) {
      throw new Error(`${item.id} was already recorded as ${saved}; finish that decision`)
    }
    if (!saved && (decision.decision === 'rejected' || decision.modified)) {
      breakStreak(item.actionType, item.conditionKey)
    }
    if (!saved) {
      await record({
        actionType: item.actionType,
        conditionKey: item.conditionKey,
        requesterRole: item.requesterRole,
        approver: decision.approver,
        decision: decision.decision,
        modified: decision.modified ?? false,
        decidedInMs: deps.clock.now() - item.requestedAt,
        decidedAt: deps.clock.now(),
        level: item.level,
        taskId: item.taskId,
        ...(decision.reason ? { reason: decision.reason } : {}),
      })
      recorded.set(item.id, decision.decision)
    }
    if (decision.decision === 'rejected') await demote(item.actionType, item.conditionKey, 'rejection')
    recorded.delete(item.id)
  }

  return {
    rules: () => rules,
    pending: () => pending,

    authorize: async (task: Task, action: DomainAction, cautious = false): Promise<Authorization> => {
      const type = typeFor(task, action)
      if (!type) {
        return {
          status: 'denied',
          code: 'ACTION_NOT_PERMITTED',
          message: `${task.domain} agent may not run ${action.system}.${action.action}`,
        }
      }
      if (!deps.humanApproval(type)) return { status: 'allow' }
      const actionKey = canonicalJson(action)
      const gate = gateOfCall.get(task.id)?.get(actionKey)
      if (gate?.id === POLICY) return { status: 'allow' }
      if (gate) {
        const outcome = decided.get(gate.id)
        if (outcome === 'approved') return { status: 'allow' }
        if (outcome === 'rejected') {
          return { status: 'denied', code: 'APPROVAL_REJECTED', message: 'the approver rejected this action' }
        }
        return { status: 'pending', approvalId: gate.id }
      }
      const conditionKey = conditionKeyOf(type, action.params)
      const level = cautious ? demoted(levelFor(type, action)) : levelFor(type, action)
      const human = needsHuman(level)
      const id = human ? `ap-${++seq}` : POLICY
      gateOfCall.set(
        task.id,
        new Map([...(gateOfCall.get(task.id) ?? []), [actionKey, { id, level, conditionKey }]]),
      )
      await deps.store.append('gate', {
        taskId: task.id,
        actionType: type.id,
        conditionKey,
        level,
        human,
        at: deps.clock.now(),
      })
      if (!human) return { status: 'allow' }
      open({
        id,
        kind: 'action',
        taskId: task.id,
        action,
        actionType: type.id,
        conditionKey,
        requesterRole: deps.roleOf(task.requester),
        approver: deps.approverFor(type, action),
        level,
        requestedAt: deps.clock.now(),
      })
      return { status: 'pending', approvalId: id }
    },

    recordExecution: async (task: Task, action: DomainAction, ok: boolean): Promise<void> => {
      const type = typeFor(task, action)
      const gate = gateOfCall.get(task.id)?.get(canonicalJson(action))
      if (!type || !ok || gate?.id !== POLICY) return
      const { level, conditionKey } = gate
      await record({
        actionType: type.id,
        conditionKey,
        requesterRole: deps.roleOf(task.requester),
        approver: POLICY,
        decision: 'approved',
        modified: false,
        decidedInMs: 0,
        decidedAt: deps.clock.now(),
        level,
        taskId: task.id,
      })
      if (level === 'notify') {
        await deps.notify(
          deps.approverFor(type, action),
          `자동 실행: ${type.id} (${conditionKey}), 업무 ${task.id}`,
        )
      }
    },

    awaitDecision: (approvalId: string): Promise<void> =>
      decided.has(approvalId)
        ? Promise.resolve()
        : new Promise((resolve) => {
            waiters.set(approvalId, [...(waiters.get(approvalId) ?? []), resolve])
          }),

    decide: async (approvalId: string, decision: Decision): Promise<void> => {
      const item = pending.find((candidate) => candidate.id === approvalId)
      if (!item || deciding.has(approvalId)) throw new Error(`no pending approval ${approvalId}`)
      if (decision.approver !== item.approver) {
        throw new Error(`${decision.approver} may not decide ${approvalId}; the approver is ${item.approver}`)
      }
      deciding.add(approvalId)
      try {
        await settle(item, decision)
      } finally {
        deciding.delete(approvalId)
      }
      pending = pending.filter((candidate) => candidate.id !== approvalId)
      decided.set(approvalId, decision.decision)
      const waiting = waiters.get(approvalId) ?? []
      waiters.delete(approvalId)
      for (const wake of waiting) wake()
    },

    forget: (taskId: string): void => {
      for (const gate of gateOfCall.get(taskId)?.values() ?? []) decided.delete(gate.id)
      gateOfCall.delete(taskId)
    },

    reportIncident: (action: DomainAction): Promise<void> => {
      const type = typeOf(`${action.system}.${action.action}`)
      if (!type) return Promise.resolve()
      const conditionKey = conditionKeyOf(type, action.params)
      breakStreak(type.id, conditionKey)
      markRuleDecided(type.id, conditionKey)
      return demote(type.id, conditionKey, 'incident')
    },

    proposePromotions: (): RuleProposal[] => {
      const openProposals = pending.flatMap((item) => (item.kind === 'rule' ? [item.proposal] : []))
      const proposals = proposePromotions(
        deps.actionTypes(),
        rules,
        records,
        (actionType, conditionKey) => ruleDecidedAt[ruleKey(actionType, conditionKey)] ?? -1,
      ).filter(
        (proposal) =>
          !openProposals.some(
            (other) =>
              other.actionType === proposal.actionType && other.conditionKey === proposal.conditionKey,
          ),
      )
      for (const proposal of proposals) {
        const type = typeOf(proposal.actionType)
        if (type) {
          open({
            id: `ap-${++seq}`,
            kind: 'rule',
            proposal,
            basis: breaksOf(proposal.actionType, proposal.conditionKey),
            approver: type.owner,
            level: 'always',
            requestedAt: deps.clock.now(),
          })
        }
      }
      return proposals
    },
  }
}

export type ApprovalDesk = ReturnType<typeof createApprovalDesk>
