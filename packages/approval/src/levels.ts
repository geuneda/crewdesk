import type { ActionType, ApprovalLevel, ApprovalRecord, JsonObject } from '@crewdesk/core'

export type ApprovalRule = { actionType: string; conditionKey: string; level: ApprovalLevel }
export type RuleProposal = {
  actionType: string
  conditionKey: string
  from: ApprovalLevel
  to: ApprovalLevel
}

const order: ApprovalLevel[] = ['always', 'recommend', 'notify', 'auto']
const rank = (level: ApprovalLevel) => order.indexOf(level)

export const needsHuman = (level: ApprovalLevel): boolean => rank(level) < rank('notify')
export const capOf = (type: ActionType): ApprovalLevel => (type.reversible ? 'auto' : 'recommend')
export const promoted = (level: ApprovalLevel): ApprovalLevel => order[rank(level) + 1] ?? level
export const demoted = (level: ApprovalLevel): ApprovalLevel => order[rank(level) - 1] ?? level

export const hasConditionFields = (type: ActionType, params: JsonObject): boolean =>
  type.conditionFields.every((field) => params[field] !== undefined)

export const conditionKeyOf = (type: ActionType, params: JsonObject): string =>
  type.conditionFields
    .map((field) => `${field}=${params[field] === undefined ? '' : JSON.stringify(params[field])}`)
    .join('&')

export const levelOf = (type: ActionType, conditionKey: string, rules: ApprovalRule[]): ApprovalLevel => {
  const rule = rules.find((item) => item.actionType === type.id && item.conditionKey === conditionKey)
  const level = rule?.level ?? type.approvalLevel
  return rank(level) > rank(capOf(type)) ? capOf(type) : level
}

export const withRule = (rules: ApprovalRule[], rule: ApprovalRule): ApprovalRule[] => [
  ...rules.filter((item) => item.actionType !== rule.actionType || item.conditionKey !== rule.conditionKey),
  rule,
]

export const proposePromotions = (
  types: ActionType[],
  rules: ApprovalRule[],
  records: ApprovalRecord[],
  lastRuleDecisionAt: (actionType: string, conditionKey: string) => number,
): RuleProposal[] =>
  types.flatMap((type) => {
    const mine = records.filter((record) => record.actionType === type.id)
    return [...new Set(mine.map((record) => record.conditionKey))].flatMap((conditionKey) => {
      const from = levelOf(type, conditionKey, rules)
      if (rank(from) >= rank(capOf(type))) return []
      const since = lastRuleDecisionAt(type.id, conditionKey)
      const recent = mine.filter((record) => record.conditionKey === conditionKey && record.decidedAt > since)
      const firstBreak = recent.findLastIndex(
        (record) => record.decision !== 'approved' || record.modified || record.level !== from,
      )
      const streak = recent.length - 1 - firstBreak
      return streak >= type.promoteAfter
        ? [{ actionType: type.id, conditionKey, from, to: promoted(from) }]
        : []
    })
  })
