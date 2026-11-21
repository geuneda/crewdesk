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
  approverFor(type: ActionType): string
  roleOf(person: string): string
  onPending(pending: PendingApproval): void
  notify(approver: string, text: string): Promise<void>
}

const ruleKey = (actionType: string, conditionKey: string) => `${actionType}|${conditionKey}`

export const createApprovalDesk = (deps: ApprovalDeskDeps) => {
  let rules: ApprovalRule[] = []
  let records: ApprovalRecord[] = []
  let pending: PendingApproval[] = []
  let decided: Record<string, 'approved' | 'rejected'> = {}
  let approvalOfCall: Record<string, string> = {}
  let ruleDecidedAt: Record<string, number> = {}
  let waiters: Record<string, (() => void)[]> = {}
  let seq = 0

  const typeOf = (id: string) => deps.actionTypes().find((type) => type.id === id)

  const record = async (entry: ApprovalRecord) => {
    records = [...records, entry]
    await deps.store.append('approval', entry)
  }

  const setRule = async (rule: ApprovalRule, from: ApprovalLevel, cause: string) => {
    rules = withRule(rules, rule)
    ruleDecidedAt = { ...ruleDecidedAt, [ruleKey(rule.actionType, rule.conditionKey)]: deps.clock.now() }
    await deps.store.append('ruleChange', { ...rule, from, cause, at: deps.clock.now() })
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

  return {
    rules: () => rules,
    pending: () => pending,

    authorize: async (task: Task, action: DomainAction): Promise<Authorization> => {
      const type = typeOf(`${action.system}.${action.action}`)
      if (!type || type.domain !== task.domain) {
        return {
          status: 'denied',
          code: 'ACTION_NOT_PERMITTED',
          message: `${task.domain} agent may not run ${action.system}.${action.action}`,
        }
      }
      const callKey = `${task.id}|${canonicalJson(action)}`
      const approvalId = approvalOfCall[callKey]
      if (approvalId) {
        const outcome = decided[approvalId]
        if (outcome === 'approved') return { status: 'allow' }
        if (outcome === 'rejected') {
          return { status: 'denied', code: 'APPROVAL_REJECTED', message: 'the approver rejected this action' }
        }
        return { status: 'pending', approvalId }
      }
      const conditionKey = conditionKeyOf(type, action.params)
      const level = levelOf(type, conditionKey, rules)
      const approver = deps.approverFor(type)
      const requesterRole = deps.roleOf(task.requester)
      if (!needsHuman(level)) {
        await record({
          actionType: type.id,
          conditionKey,
          requesterRole,
          approver: 'policy',
          decision: 'approved',
          modified: false,
          decidedInMs: 0,
          decidedAt: deps.clock.now(),
          level,
          taskId: task.id,
        })
        if (level === 'notify')
          await deps.notify(approver, `자동 실행: ${type.id} (${conditionKey}), 업무 ${task.id}`)
        return { status: 'allow' }
      }
      const id = `ap-${++seq}`
      approvalOfCall = { ...approvalOfCall, [callKey]: id }
      open({
        id,
        kind: 'action',
        taskId: task.id,
        action,
        actionType: type.id,
        conditionKey,
        requesterRole,
        approver,
        level,
        requestedAt: deps.clock.now(),
      })
      return { status: 'pending', approvalId: id }
    },

    awaitDecision: (approvalId: string): Promise<void> =>
      decided[approvalId]
        ? Promise.resolve()
        : new Promise((resolve) => {
            waiters = { ...waiters, [approvalId]: [...(waiters[approvalId] ?? []), resolve] }
          }),

    decide: async (approvalId: string, decision: Decision): Promise<void> => {
      const item = pending.find((candidate) => candidate.id === approvalId)
      if (!item) throw new Error(`no pending approval ${approvalId}`)
      if (decision.approver !== item.approver) {
        throw new Error(`${decision.approver} may not decide ${approvalId}; the approver is ${item.approver}`)
      }
      pending = pending.filter((candidate) => candidate.id !== approvalId)
      decided = { ...decided, [approvalId]: decision.decision }
      if (item.kind === 'rule') {
        const { proposal } = item
        if (decision.decision === 'approved') {
          await setRule(
            { actionType: proposal.actionType, conditionKey: proposal.conditionKey, level: proposal.to },
            proposal.from,
            'promotion',
          )
        } else {
          ruleDecidedAt = {
            ...ruleDecidedAt,
            [ruleKey(proposal.actionType, proposal.conditionKey)]: deps.clock.now(),
          }
        }
      } else {
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
      const waiting = waiters[approvalId] ?? []
      waiters = Object.fromEntries(Object.entries(waiters).filter(([id]) => id !== approvalId))
      for (const wake of waiting) wake()
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
