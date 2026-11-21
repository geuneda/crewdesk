import type { ClockPort, ModelUsage, Seat, StorePort, UsageRecord, UsageReport } from '@crewdesk/core'
import { quotaLeft, quotaResetAt, quotaUnits, windowIndex } from './seats.ts'

export type Price = { inputPerMTok: number; outputPerMTok: number; cachedPerMTok: number }
export type Pricing = Record<string, Price>

export const usdOf = (pricing: Pricing, usage: ModelUsage): number => {
  const price = pricing[usage.model]
  if (!price) throw new Error(`no price for model ${usage.model}`)
  return (
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cachedTokens * price.cachedPerMTok) /
    1_000_000
  )
}

export type LedgerDeps = {
  store: StorePort
  clock: ClockPort
  pricing: Pricing
  seats: Seat[]
  sharedSeat: string
}

export const createLedger = (deps: LedgerDeps) => {
  const seatOfTask = new Map<string, string>()
  let used: Record<string, number> = {}

  const seatById = (id: string): Seat => {
    const seat = deps.seats.find((candidate) => candidate.id === id)
    if (!seat) throw new Error(`unknown seat ${id}`)
    return seat
  }
  const counter = (seat: string, lengthMs: number) =>
    `${seat}|${lengthMs}|${windowIndex(lengthMs, deps.clock.now())}`
  const usedIn = (seat: string) => (lengthMs: number) => used[counter(seat, lengthMs)] ?? 0
  const consume = (seat: Seat, units: number) => {
    for (const window of seat.windows ?? []) {
      const key = counter(seat.id, window.lengthMs)
      used = { ...used, [key]: (used[key] ?? 0) + units }
    }
  }

  return {
    assign: (taskId: string, seatId: string): void => {
      seatById(seatId)
      seatOfTask.set(taskId, seatId)
    },
    assigned: (taskId: string): string | undefined => seatOfTask.get(taskId),
    unassign: (taskId: string): void => {
      seatOfTask.delete(taskId)
    },
    left: (seatId: string): number => quotaLeft(seatById(seatId), usedIn(seatId)),
    resetAt: (seatId: string): number => quotaResetAt(seatById(seatId), usedIn(seatId), deps.clock.now()),
    drain: (seatId: string, units: number): void => consume(seatById(seatId), units),
    record: async ({ taskId, stage, usage, ok }: UsageReport): Promise<UsageRecord> => {
      const seat = seatById((stage === 'work' && seatOfTask.get(taskId)) || deps.sharedSeat)
      const units = quotaUnits(usage)
      const limit = seat.windows?.[0]?.limit
      const record: UsageRecord = {
        taskId,
        stage,
        seat: seat.id,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        cost:
          seat.kind === 'quota' && limit
            ? { unit: 'quotaShare', amount: units / limit }
            : { unit: 'usd', amount: usdOf(deps.pricing, usage) },
        ok,
        at: deps.clock.now(),
      }
      if (seat.kind === 'quota') consume(seat, units)
      await deps.store.append('usage', record)
      return record
    },
  }
}

export type Ledger = ReturnType<typeof createLedger>
