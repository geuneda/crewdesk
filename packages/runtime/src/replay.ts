import type { RunRequest, RuntimeEvent, RuntimePort, ToolHost } from '@crewdesk/core'

export type Recording = { key: string; events: RuntimeEvent[] }
export type KeyOf = (request: RunRequest) => string

const terminal = (event: RuntimeEvent) => event.type === 'done' || event.type === 'error'

export const recordRuntime = (
  inner: RuntimePort,
  keyOf: KeyOf,
  save: (recording: Recording) => void,
): RuntimePort => {
  const open = new Map<string, Recording>()

  async function* tap(
    recording: Recording,
    stream: AsyncIterable<RuntimeEvent>,
  ): AsyncGenerator<RuntimeEvent> {
    let events = recording.events
    for await (const event of stream) {
      events = [...events, event]
      if (event.type === 'approvalRequired') open.set(event.resumeToken, { ...recording, events })
      if (terminal(event)) save({ ...recording, events })
      yield event
    }
  }

  return {
    start: (request, tools) => tap({ key: keyOf(request), events: [] }, inner.start(request, tools)),
    resume: (resumeToken, tools) => {
      const recording = open.get(resumeToken)
      open.delete(resumeToken)
      return recording ? tap(recording, inner.resume(resumeToken, tools)) : inner.resume(resumeToken, tools)
    },
  }
}

export const createReplayRuntime = (recordings: Recording[], keyOf: KeyOf): RuntimePort => {
  const played = new Map<string, number>()
  const paused = new Map<string, { events: RuntimeEvent[]; turnsLeft: number }>()
  let tokens = 0

  async function* play(
    recorded: RuntimeEvent[],
    tools: ToolHost,
    budget: number,
    resumed = false,
  ): AsyncGenerator<RuntimeEvent> {
    let turnsLeft = budget
    let announced = !resumed
    for (const [index, event] of recorded.entries()) {
      if (event.type === 'toolResult' || event.type === 'approvalRequired') continue
      if (event.type === 'usage') {
        if (turnsLeft <= 0) {
          yield { type: 'error', code: 'BUDGET_EXCEEDED', transient: false, message: 'turn budget used up' }
          return
        }
        turnsLeft -= 1
      }
      if (event.type !== 'toolCall') {
        yield event
        if (terminal(event)) return
        continue
      }
      const { type: _, ...call } = event
      if (announced) yield event
      announced = true
      const result = await tools.call(call)
      if (result.status === 'approvalRequired') {
        const resumeToken = `replay-${++tokens}`
        paused.set(resumeToken, { events: recorded.slice(index), turnsLeft })
        yield { type: 'approvalRequired', callId: call.callId, approvalId: result.approvalId, resumeToken }
        return
      }
      yield {
        type: 'toolResult',
        callId: call.callId,
        ok: result.status === 'ok',
        output: result.status === 'ok' ? result.output : { code: result.code, message: result.message },
      }
      const then = recorded.find((other) => other.type === 'toolResult' && other.callId === call.callId)
      if (then?.type === 'toolResult' && then.ok !== (result.status === 'ok')) {
        yield {
          type: 'error',
          code: 'REPLAY_DIVERGED',
          transient: false,
          message: `${call.tool} ${call.callId} was ${then.ok ? 'ok' : 'refused'} when recorded`,
        }
        return
      }
    }
  }

  const fail = (code: string, message: string): RuntimeEvent[] => [
    { type: 'error', code, transient: false, message },
  ]

  return {
    start: (request, tools) => {
      const key = keyOf(request)
      const takes = recordings.filter((recording) => recording.key === key)
      const turn = played.get(key) ?? 0
      played.set(key, turn + 1)
      const take = takes[turn % Math.max(takes.length, 1)]
      return play(take ? take.events : fail('NO_RECORDING', key), tools, request.budget.turns)
    },
    resume: (resumeToken, tools) => {
      const state = paused.get(resumeToken)
      paused.delete(resumeToken)
      return state
        ? play(state.events, tools, state.turnsLeft, true)
        : play(fail('UNKNOWN_RESUME_TOKEN', resumeToken), tools, 0)
    },
  }
}
