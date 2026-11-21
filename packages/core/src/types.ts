export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export type Domain = 'access' | 'deploy' | 'incident'
export type Risk = 'low' | 'medium' | 'high'
export type Urgency = 'low' | 'normal' | 'high'
export type TaskStatus =
  | 'received'
  | 'queued'
  | 'running'
  | 'awaitingApproval'
  | 'verifying'
  | 'done'
  | 'escalated'

export type Budget = { tokens: number; turns: number; subagents: number }

export type Task = {
  id: string
  requester: string
  channel: string
  thread: string
  body: string
  domain: Domain
  taskType: string
  risk: Risk
  urgency: Urgency
  status: TaskStatus
  budget: Budget
  createdAt: number
}

export type ApprovalLevel = 'always' | 'recommend' | 'notify' | 'auto'

export type ActionType = {
  id: string
  domain: Domain
  reversible: boolean
  owner: string
  approvalLevel: ApprovalLevel
  promoteAfter: number
  conditionFields: string[]
}

export type ApprovalRecord = {
  actionType: string
  conditionKey: string
  requesterRole: string
  approver: string
  decision: 'approved' | 'rejected'
  modified: boolean
  decidedInMs: number
  decidedAt: number
  level: ApprovalLevel
  taskId?: string
  reason?: string
}

export type KnowledgeEntry = {
  id: string
  kind: 'entity' | 'relation' | 'mapping' | 'rule'
  owner: string
  confidence: 'confirmed' | 'assumed'
  taskTypes: string[]
  data: JsonObject
  evidence?: string
  lastVerifiedAt?: string
  lastUsedOkAt?: string
}

export type DiscrepancyReport = {
  entryId: string
  expected: string
  observed: string
  evidence: string
  source: 'runtime' | 'humanCorrection' | 'systemEvent'
  reportedAt: number
  taskId?: string
}

export type Seat = {
  id: string
  agent: string
  kind: 'metered' | 'quota'
  windows?: { lengthMs: number; limit: number }[]
}

export type Stage = 'intake' | 'work' | 'close' | 'batch' | 'eval'

export type UsageRecord = {
  taskId: string
  stage: Stage
  seat: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cost: { unit: 'usd' | 'quotaShare'; amount: number }
  ok: boolean
  at: number
}
