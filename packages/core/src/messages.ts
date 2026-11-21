import type { Budget, Domain, Json, JsonObject, KnowledgeEntry, Risk, Task, Urgency } from './types.ts'

export type InboundMessage = {
  id: string
  channel: string
  thread: string
  sender: string
  body: string
  mentionsAgent: boolean
  isDirect: boolean
  at: number
}

export type OutboundMessage = {
  channel: string
  thread: string
  body: string
  at: number
}

export type CatalogItem = {
  domain: Domain
  taskType: string
  description: string
  aliases: string[]
  risk: Risk
}

export type Classification = {
  domain: Domain
  taskType: string
  risk: Risk
  urgency: Urgency
}

export type ModelUsage = {
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export type ClassifyRequest = { model: string; body: string; catalog: CatalogItem[] }
export type ClassifyResponse = {
  classification: Classification | null
  confidence: number
  usage: ModelUsage
}
export type ReplyRequest = { model: string; task: Task; outcome: 'done' | 'escalated'; facts: JsonObject }
export type ReplyResponse = { text: string; usage: ModelUsage }

export type ToolCall = { callId: string; tool: string; input: JsonObject }

export type ToolResult =
  | { status: 'ok'; output: Json }
  | { status: 'error'; code: string; message: string; detail?: JsonObject }
  | { status: 'approvalRequired'; approvalId: string }

export type ToolHost = { call(call: ToolCall): Promise<ToolResult> }

export type RunRequest = {
  task: Task
  agent: string
  model: string
  knowledge: KnowledgeEntry[]
  budget: Budget
}

export type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; callId: string; tool: string; input: JsonObject }
  | { type: 'toolResult'; callId: string; ok: boolean; output: Json }
  | { type: 'approvalRequired'; callId: string; approvalId: string; resumeToken: string }
  | ({ type: 'usage' } & ModelUsage)
  | { type: 'done'; ok: boolean; result: JsonObject }
  | { type: 'error'; code: string; transient: boolean; message: string }

export type DomainError = { code: string; message: string; detail?: JsonObject }
export type DomainResult<T> = { ok: true; value: T } | { ok: false; error: DomainError }
export type DomainQuery = { system: string; resource: string; where?: Record<string, string | number> }
export type DomainAction = { system: string; action: string; params: JsonObject }
export type ChangeEvent = { seq: number; at: number; system: string; kind: string; detail: JsonObject }
