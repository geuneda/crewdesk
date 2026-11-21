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
  | { kind: 'rule'; proposal: RuleProposal }
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
  humanApproval(): boolean
  onPending(pending: PendingApproval): void
  notify(approver: string, text: string): Promise<void>
}

const POLICY = 'policy'
const ruleKey = (actionType: string, conditionKey: string) => `${actionType}|${conditionKey}`

export const createApprovalDesk = (deps: ApprovalDeskDeps) => {
  let rules: ApprovalRule[] = []
  let records: ApprovalRecord[] = []
  let pending: PendingApproval[] = []
  let ruleDecidedAt: Record<string, number> = {}
  let seq = 0
  const gateOfCall = new Map<string, Map<string, string>>()
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

  const demote = async (actionType: string, conditionKey: string, cause: string) => {
    const type = typeOf(actionType)
    if (!type) return
    const from = levelOf(type, conditionKey, rules)
    if (demoted(from) !== from) await setRule({ actionType, conditionKey, level: demoted(from) }, from, cause)
  }

  const open = (item: PendingApproval) => {
    pending = [...pending, item]
    deps.onPending(item)
  }

  const settle = async (item: PendingApproval, decision: Decision) => {
    if (item.kind === 'rule') {
      const { actionType, conditionKey, from, to } = item.proposal
      const type = typeOf(actionType)
      const stillValid = type !== undefined && levelOf(type, conditionKey, rules) === from
      if (decision.decision === 'approved' && stillValid) {
        await setRule({ actionType, conditionKey, level: to }, from, 'promotion')
      } else {
        markRuleDecided(actionType, conditionKey)
      }
      return
    }
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
    if (decision.decision === 'rejected') await demote(item.actionType, item.conditionKey, 'rejection')
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
      if (!deps.humanApproval()) return { status: 'allow' }
      const actionKey = canonicalJson(action)
      const gate = gateOfCall.get(task.id)?.get(actionKey)
      if (gate === POLICY) return { status: 'allow' }
      if (gate) {
        const outcome = decided.get(gate)
        if (outcome === 'approved') return { status: 'allow' }
        if (outcome === 'rejected') {
          return { status: 'denied', code: 'APPROVAL_REJECTED', message: 'the approver rejected this action' }
        }
        return { status: 'pending', approvalId: gate }
      }
      const conditionKey = conditionKeyOf(type, action.params)
      const level = cautious ? demoted(levelFor(type, action)) : levelFor(type, action)
      const human = needsHuman(level)
      const id = human ? `ap-${++seq}` : POLICY
      gateOfCall.set(task.id, new Map([...(gateOfCall.get(task.id) ?? []), [actionKey, id]]))
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
      if (!type || !ok || gateOfCall.get(task.id)?.get(canonicalJson(action)) !== POLICY) return
      const conditionKey = conditionKeyOf(type, action.params)
      const level = levelFor(type, action)
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
      for (const gate of gateOfCall.get(taskId)?.values() ?? []) decided.delete(gate)
      gateOfCall.delete(taskId)
    },

    reportIncident: (action: DomainAction): Promise<void> => {
      const type = typeOf(`${action.system}.${action.action}`)
      return type ? demote(type.id, conditionKeyOf(type, action.params), 'incident') : Promise.resolve()
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
