import type { ApprovalDesk } from '@crewdesk/approval'
import type {
  ClockPort,
  DiscrepancyReport,
  DomainSystemPort,
  Json,
  StorePort,
  Task,
  UsageReport,
} from '@crewdesk/core'
import {
  type Evidence,
  type KnowledgeBase,
  parseEvidence,
  patchEntry,
  reportsFromChange,
} from '@crewdesk/knowledge'

export type KnowledgeChange = { entryId: string; field: string; from: Json; to: string; proposedAt: number }

export type BatchDeps = {
  systems: DomainSystemPort
  store: StorePort
  clock: ClockPort
  kb(): KnowledgeBase
  evaluate(kb: KnowledgeBase, change: KnowledgeChange | null): Promise<number>
  apply(change: KnowledgeChange): Promise<void>
  approvals: Pick<
    ApprovalDesk,
    'authorize' | 'awaitDecision' | 'recordExecution' | 'forget' | 'proposePromotions'
  >
  recordUsage(report: UsageReport): Promise<void>
  model: string
  onError(error: unknown): void
}

export type BatchSummary = { reports: number; confirmed: number; proposed: number; unresolved: number }

type Confirmed = { report: DiscrepancyReport; evidence: Evidence }

const groupKey = (item: Confirmed) => `${item.report.entryId}|${item.evidence.field}`

export const createBatch = (deps: BatchDeps) => {
  let changeSeq = 0
  let reportsSeen = 0
  let runs = 0
  let open: ReadonlySet<string> = new Set()

  const collectChanges = async () => {
    const events = await deps.systems.changes(changeSeq)
    changeSeq = events.at(-1)?.seq ?? changeSeq
    for (const event of events) {
      for (const report of reportsFromChange(deps.kb(), event, deps.clock.now())) {
        await deps.store.append('discrepancy', report)
      }
    }
  }

  const confirm = async (reports: DiscrepancyReport[]): Promise<Confirmed[]> => {
    const checked = await Promise.all(
      reports.map(async (report) => {
        const evidence = parseEvidence(report.evidence)
        if (!evidence) return []
        const rows = await deps.systems.query(evidence.query)
        return rows.ok && rows.value.length === 0 ? [{ report, evidence }] : []
      }),
    )
    return checked.flat()
  }

  const submit = async (change: KnowledgeChange, key: string) => {
    const entry = deps.kb().entries.find((candidate) => candidate.id === change.entryId)
    if (!entry) return
    const task: Task = {
      id: `batch-${runs}-${change.entryId}-${change.field}`,
      requester: 'batch',
      channel: 'batch',
      thread: change.entryId,
      body: `${change.entryId}: ${change.field} ${String(change.from)} -> ${change.to}`,
      domain: 'knowledge',
      taskType: 'knowledge.patch',
      risk: entry.kind === 'relation' ? 'high' : 'low',
      urgency: 'normal',
      status: 'running',
      budget: { tokens: 0, turns: 0, subagents: 0 },
      createdAt: deps.clock.now(),
    }
    const action = {
      system: 'knowledge',
      action: entry.kind === 'relation' ? 'patchRelation' : 'patchMapping',
      params: {
        entryId: entry.id,
        owner: entry.owner,
        concept: String(entry.data.concept ?? entry.data.type ?? entry.kind),
        field: change.field,
        to: change.to,
      },
    }
    try {
      const first = await deps.approvals.authorize(task, action)
      if (first.status === 'pending') await deps.approvals.awaitDecision(first.approvalId)
      const permit = first.status === 'pending' ? await deps.approvals.authorize(task, action) : first
      if (permit.status !== 'allow') {
        await deps.store.append('knowledgeProposalRejected', { ...change, at: deps.clock.now() })
        return
      }
      await deps.apply(change)
      await deps.approvals.recordExecution(task, action, true)
    } finally {
      deps.approvals.forget(task.id)
      open = new Set([...open].filter((other) => other !== key))
    }
  }

  const propose = async (key: string, group: Confirmed[]): Promise<'proposed' | 'unresolved' | 'skipped'> => {
    const first = group[0]
    const entry = deps.kb().entries.find((candidate) => candidate.id === first?.report.entryId)
    if (!first || !entry || open.has(key)) return 'skipped'
    const { field } = first.evidence
    const to = group.find((item) => item.evidence.to !== undefined)?.evidence.to
    if (to === undefined) {
      await deps.store.append('knowledgeUnresolved', {
        entryId: entry.id,
        field,
        reports: group.length,
        at: deps.clock.now(),
      })
      return 'unresolved'
    }
    if (entry.data[field] === to) return 'skipped'
    const change: KnowledgeChange = {
      entryId: entry.id,
      field,
      from: entry.data[field] ?? null,
      to,
      proposedAt: deps.clock.now(),
    }
    const before = await deps.evaluate(deps.kb(), null)
    const after = await deps.evaluate(patchEntry(deps.kb(), entry.id, { [field]: to }), change)
    const passed = after >= before
    await deps.store.append('knowledgeProposal', { ...change, evalBefore: before, evalAfter: after, passed })
    if (!passed) return 'skipped'
    open = new Set([...open, key])
    void submit(change, key).catch(deps.onError)
    return 'proposed'
  }

  return {
    run: async (): Promise<BatchSummary> => {
      runs += 1
      await collectChanges()
      const all = (await deps.store.list('discrepancy')) as DiscrepancyReport[]
      const fresh = all.slice(reportsSeen)
      reportsSeen = all.length
      const confirmed = await confirm(fresh)
      const keys = [...new Set(confirmed.map(groupKey))]
      let outcomes: string[] = []
      for (const key of keys) {
        outcomes = [
          ...outcomes,
          await propose(
            key,
            confirmed.filter((item) => groupKey(item) === key),
          ),
        ]
      }
      deps.approvals.proposePromotions()
      const proposed = outcomes.filter((outcome) => outcome === 'proposed').length
      if (fresh.length > 0) {
        await deps.recordUsage({
          taskId: `batch-${runs}`,
          stage: 'batch',
          usage: {
            model: deps.model,
            inputTokens: Math.ceil(JSON.stringify(fresh).length / 4),
            outputTokens: 200 * (proposed + 1),
            cachedTokens: 0,
          },
          ok: true,
        })
      }
      return {
        reports: fresh.length,
        confirmed: confirmed.length,
        proposed,
        unresolved: outcomes.filter((outcome) => outcome === 'unresolved').length,
      }
    },
  }
}
