import type { Decision, PendingApproval } from '@crewdesk/approval'
import type { ClockPort, RandomPort } from '@crewdesk/core'
import { MINUTE, nextWorkTime } from './time.ts'

export type ApproverPolicy = {
  rejectRate: number
  adminRejectRate: number
  modifyRate: number
}

const delayMinutes = (pending: PendingApproval): [number, number] => {
  if (pending.kind === 'rule') return [30, 240]
  return pending.level === 'recommend' ? [2, 20] : [10, 180]
}

export const createVirtualApprovers = (options: {
  clock: ClockPort
  random: RandomPort
  policy: ApproverPolicy
  decide(approvalId: string, decision: Decision): Promise<void>
}) => {
  const { clock, random, policy } = options
  return async (pending: PendingApproval): Promise<void> => {
    const [min, max] = delayMinutes(pending)
    const at = nextWorkTime(clock.now() + (min + random.next() * (max - min)) * MINUTE)
    await clock.sleep(at - clock.now())
    const risky = pending.kind === 'action' && pending.action.params.role_cd === 'AD'
    const rejected =
      pending.kind === 'action' && random.next() < (risky ? policy.adminRejectRate : policy.rejectRate)
    const modified = pending.kind === 'action' && !rejected && random.next() < policy.modifyRate
    await options.decide(pending.id, {
      approver: pending.approver,
      decision: rejected ? 'rejected' : 'approved',
      modified,
      ...(rejected ? { reason: '요청 사유가 부족합니다' } : {}),
    })
  }
}
