import type {
  ChangeEvent,
  ClassifyRequest,
  ClassifyResponse,
  DomainAction,
  DomainQuery,
  DomainResult,
  InboundMessage,
  OutboundMessage,
  ReplyRequest,
  ReplyResponse,
  RunRequest,
  RuntimeEvent,
  ToolHost,
} from './messages.ts'
import type { Json, JsonObject } from './types.ts'

export type ChannelPort = {
  poll(): Promise<InboundMessage[]>
  send(message: OutboundMessage): Promise<void>
}

export type RuntimePort = {
  start(request: RunRequest, tools: ToolHost): AsyncIterable<RuntimeEvent>
  resume(resumeToken: string, tools: ToolHost): AsyncIterable<RuntimeEvent>
}

export type ModelPort = {
  classify(request: ClassifyRequest): Promise<ClassifyResponse>
  reply(request: ReplyRequest): Promise<ReplyResponse>
}

export type DomainSystemPort = {
  query(query: DomainQuery): Promise<DomainResult<JsonObject[]>>
  execute(action: DomainAction): Promise<DomainResult<Json>>
  changes(sinceSeq: number): Promise<ChangeEvent[]>
}

export type QueuePort<T extends Json> = {
  enqueue(item: T, priority?: number): Promise<void>
  dequeue(): Promise<T | null>
  size(): Promise<number>
}

export type StorePort = {
  append(kind: string, record: JsonObject): Promise<void>
  put(kind: string, id: string, record: JsonObject): Promise<void>
  get(kind: string, id: string): Promise<JsonObject | null>
  list(kind: string, where?: Record<string, string | number>): Promise<JsonObject[]>
}

export type ClockPort = {
  now(): number
  sleep(ms: number): Promise<void>
}

export type RandomPort = {
  next(): number
}
