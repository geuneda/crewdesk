import { canonicalJson, type DomainAction, type JsonObject, type Task } from '@crewdesk/core'
import type { SimResult } from '../engine.ts'

type TraceAction = { action: DomainAction; result: { ok: boolean } }

export const summarize = (result: SimResult) => {
  const count = (status: Task['status']) => result.tasks.filter((task) => task.status === status).length
  const correct = result.traces.filter((trace) => {
    const last = (trace.actions as unknown as TraceAction[]).filter((done) => done.result.ok).at(-1)
    const expected = result.expected[String(trace.taskId)]
    return trace.ok === true && last && expected && canonicalJson(last.action) === canonicalJson(expected)
  }).length
  const reasonOf = (trace: JsonObject) => (typeof trace.reason === 'string' ? trace.reason : 'OK')
  const reasons = Object.fromEntries(
    [...new Set(result.traces.map(reasonOf))].map((reason) => [
      reason,
      result.traces.filter((trace) => reasonOf(trace) === reason).length,
    ]),
  )
  return {
    messages: result.messages,
    requests: Object.keys(result.expected).length,
    tasks: result.tasks.length,
    done: count('done'),
    escalated: count('escalated'),
    awaitingApproval: count('awaitingApproval'),
    correct,
    reasons,
    tokens: result.usage.reduce(
      (sum, record) => sum + record.inputTokens + record.outputTokens + record.cachedTokens,
      0,
    ),
  }
}
