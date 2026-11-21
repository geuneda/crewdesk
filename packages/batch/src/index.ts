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
  evaluate(kb: KnowledgeBase, change: KnowledgeChange | null): Promise<number | null>
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
type Rename = { path: string; from: string; to: string }
type Outcome = 'proposed' | 'unresolved' | 'skipped'

const groupKey = (item: Confirmed) => `${item.report.entryId}|${item.evidence.field}`

export const createBatch = (deps: BatchDeps) => {
  let changeSeq = 0
  let reportsSeen = 0
  let runs = 0
  let renames: Rename[] = []
  let open: ReadonlySet<string> = new Set()

  const collectChanges = async () => {
    const events = await deps.systems.changes(changeSeq)
    changeSeq = events.at(-1)?.seq ?? changeSeq
    for (const event of events) {
      const { system, resource, field, from, to } = event.detail
      if (event.kind === 'codeChange' && typeof from === 'string' && typeof to === 'string') {
        renames = [...renames, { path: `${String(system)}/${String(resource)}/${String(field)}`, from, to }]
      }
      for (const report of reportsFromChange(deps.kb(), event, deps.clock.now())) {
        await deps.store.append('discrepancy', report)
      }
    }
  }

  const latestValue = (path: string, value: Json): Json =>
    renames.reduce<Json>(
      (current, rename) => (rename.path === path && rename.from === current ? rename.to : current),
      value,
    )

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

  const unresolved = async (entryId: string, field: string, reason: string): Promise<Outcome> => {
    await deps.store.append('knowledgeUnresolved', { entryId, field, reason, at: deps.clock.now() })
    return 'unresolved'
  }

  const candidateFor = async (evidence: Evidence, current: Json): Promise<string | null> => {
    const { system, resource } = evidence.query
    const to = latestValue(`${system}/${resource}/${evidence.column}`, current)
    if (typeof to !== 'string' || to === current) return null
    const rows = await deps.systems.query({ system, resource, where: { [evidence.column]: to } })
    return rows.ok && rows.value.length > 0 ? to : null
  }

  const propose = async (key: string, evidence: Evidence, entryId: string): Promise<Outcome> => {
    const entry = deps.kb().entries.find((candidate) => candidate.id === entryId)
    if (!entry || open.has(key)) return 'skipped'
    const { field } = evidence
    const from = entry.data[field] ?? null
    const to = await candidateFor(evidence, from)
    if (to === null) return unresolved(entry.id, field, 'the source system shows no replacement value')
    const change: KnowledgeChange = { entryId: entry.id, field, from, to, proposedAt: deps.clock.now() }
    const before = await deps.evaluate(deps.kb(), null)
    const after = await deps.evaluate(patchEntry(deps.kb(), entry.id, { [field]: to }), change)
    if (before === null || after === null)
      return unresolved(entry.id, field, 'there are no eval questions to check the change')
    const passed = after >= before
    await deps.store.append('knowledgeProposal', { ...change, evalBefore: before, evalAfter: after, passed })
    if (!passed) return 'skipped'
    open = new Set([...open, key])
    void submit(change, key, evidence).catch(deps.onError)
    return 'proposed'
  }

  const submit = async (change: KnowledgeChange, key: string, evidence: Evidence) => {
    const entry = deps.kb().entries.find((candidate) => candidate.id === change.entryId)
    if (!entry) return
    const task: Task = {
      id: `batch-${runs}-${change.entryId}-${change.field}-${change.to}`,
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
    let stale = false
    try {
      const first = await deps.approvals.authorize(task, action)
      if (first.status === 'pending') await deps.approvals.awaitDecision(first.approvalId)
      const permit = first.status === 'pending' ? await deps.approvals.authorize(task, action) : first
      if (permit.status !== 'allow') {
        await deps.store.append('knowledgeProposalRejected', { ...change, at: deps.clock.now() })
        return
      }
      const current = deps.kb().entries.find((candidate) => candidate.id === change.entryId)?.data[
        change.field
      ]
      stale = current !== change.from || (await candidateFor(evidence, change.from)) !== change.to
      if (stale) {
        await deps.store.append('knowledgeProposalStale', { ...change, at: deps.clock.now() })
        return
      }
      await deps.apply(change)
      await deps.approvals.recordExecution(task, action, true)
    } finally {
      deps.approvals.forget(task.id)
      open = new Set([...open].filter((other) => other !== key))
      if (stale) await propose(key, evidence, change.entryId)
    }
  }

  return {
    run: async (): Promise<BatchSummary> => {
      runs += 1
      await collectChanges()
      const all = (await deps.store.list('discrepancy')) as DiscrepancyReport[]
      const fresh = all.slice(reportsSeen)
      reportsSeen = all.length
      const confirmed = await confirm(fresh)
      let outcomes: Outcome[] = []
      for (const key of new Set(confirmed.map(groupKey))) {
        const first = confirmed.find((item) => groupKey(item) === key)
        if (first) outcomes = [...outcomes, await propose(key, first.evidence, first.report.entryId)]
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
