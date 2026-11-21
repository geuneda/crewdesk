import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyOverlay,
  type Distro,
  distroFromSnapshot,
  knowledgeHash,
  loadDistro,
  type Overlay,
  parseOverlay,
  parseSnapshot,
  type Snapshot,
  snapshotOf,
} from '@crewdesk/distro'
import { runEval } from '@crewdesk/eval'
import { renderWiki } from '@crewdesk/knowledge'
import { routeModel } from '@crewdesk/ops'
import {
  approvalCurve,
  createEvalAgent,
  createSqliteStore,
  defaultScenarioEvents,
  defaultSimConfig,
  renderApprovalReport,
  renderBreakEvenReport,
  renderCostReport,
  renderKnowledgeReport,
  renderStalenessReport,
  runBreakEven,
  runCostComparison,
  runSimulation,
  simSettingsFrom,
  stalenessTimeline,
  summarize,
} from '@crewdesk/sim'
import { parseDocument } from 'yaml'
import { readRecordings, replayKnowledgeEffect } from './record.ts'
import { checkUpgrade, demoNextBase, renderUpgradeReport } from './upgradeReport.ts'

export type Outcome = { code: number; lines: string[] }

const files = (dir: string) => ({
  overlay: join(dir, 'overlay.yaml'),
  lock: join(dir, 'base.lock.json'),
  resolved: join(dir, 'resolved.json'),
  wiki: join(dir, 'wiki.md'),
})

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const replaceFile = async (path: string, body: string) => {
  await writeFile(`${path}.tmp`, body)
  await rename(`${path}.tmp`, path)
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const readOverlay = async (dir: string): Promise<Overlay> =>
  parseOverlay(await readFile(files(dir).overlay, 'utf8'))

const readLock = async (dir: string): Promise<Snapshot> =>
  parseSnapshot(JSON.parse(await readFile(files(dir).lock, 'utf8')))

const writeResolved = async (dir: string, base: Distro, overlay: Overlay) => {
  const merged = applyOverlay(base, overlay)
  await replaceFile(
    files(dir).resolved,
    json({
      name: merged.name,
      org: overlay.org,
      version: merged.version,
      knowledgeHash: knowledgeHash(merged.kb),
      settings: merged.settings,
      prompts: merged.prompts,
      knowledge: merged.kb.entries,
    }),
  )
  await replaceFile(files(dir).wiki, renderWiki(merged.kb))
  return merged
}

export const init = async (options: { dir: string; org: string; base: string }): Promise<Outcome> => {
  const paths = files(options.dir)
  if (await exists(paths.overlay)) return { code: 1, lines: [`${paths.overlay} already exists`] }
  const base = await loadDistro(options.base)
  await mkdir(options.dir, { recursive: true })
  await writeFile(
    paths.overlay,
    `org: ${JSON.stringify(options.org)}\nbaseVersion: ${base.version}\nsettings: {}\nknowledge: {}\n`,
  )
  await writeFile(paths.lock, json(snapshotOf(base)))
  return { code: 0, lines: [`initialised ${options.org} on ${base.name} ${base.version}`] }
}

export const deploy = async (options: { dir: string; base: string }): Promise<Outcome> => {
  const base = await loadDistro(options.base)
  const lock = await readLock(options.dir)
  if (lock.version !== base.version) {
    return {
      code: 1,
      lines: [`the base is ${base.version} but this deployment is locked to ${lock.version}: run upgrade`],
    }
  }
  const overlay = await readOverlay(options.dir)
  const merged = await writeResolved(options.dir, base, overlay)
  return {
    code: 0,
    lines: [`deployed ${overlay.org} at ${merged.version}, knowledge ${knowledgeHash(merged.kb)}`],
  }
}

export const upgrade = async (options: { dir: string; base: string }): Promise<Outcome> => {
  const paths = files(options.dir)
  const next = await loadDistro(options.base)
  const lock = await readLock(options.dir)
  if (lock.version === next.version) return { code: 0, lines: [`already at ${next.version}`] }
  const overlay = await readOverlay(options.dir)
  const outcome = await checkUpgrade(distroFromSnapshot(lock, next), next, overlay)
  const examNotes = [
    ...(outcome.questionsAdded.length > 0
      ? [`new questions, not part of this check: ${outcome.questionsAdded.join(', ')}`]
      : []),
    ...(outcome.questionsRemoved.length > 0
      ? [`questions removed by the new base, still checked: ${outcome.questionsRemoved.join(', ')}`]
      : []),
  ]
  if (outcome.status === 'conflict') {
    return {
      code: 1,
      lines: [
        `upgrade ${lock.version} -> ${next.version} stopped: ${outcome.conflicts.length} conflict(s)`,
        ...outcome.conflicts.map(
          (conflict) =>
            `  ${conflict.path}: overlay ${JSON.stringify(conflict.overlay)}, base ${JSON.stringify(conflict.was)} -> ${JSON.stringify(conflict.now)}`,
        ),
        'resolve each conflict in overlay.yaml, then run upgrade again',
      ],
    }
  }
  if (outcome.status === 'evalFailed') {
    return {
      code: 1,
      lines: [
        outcome.accuracyBefore === null
          ? `upgrade ${lock.version} -> ${next.version} stopped: the locked base has no eval questions to check against`
          : `upgrade ${lock.version} -> ${next.version} stopped: eval accuracy fell from ${outcome.accuracyBefore} to ${outcome.accuracyAfter}`,
        ...examNotes,
      ],
    }
  }
  const document = parseDocument(await readFile(paths.overlay, 'utf8'))
  document.set('baseVersion', next.version)
  await writeResolved(options.dir, next, { ...overlay, baseVersion: next.version })
  await replaceFile(paths.overlay, document.toString())
  await replaceFile(paths.lock, json(snapshotOf(next)))
  return {
    code: 0,
    lines: [
      `upgraded ${overlay.org} ${lock.version} -> ${next.version}, eval ${outcome.accuracyAfter}`,
      ...examNotes,
    ],
  }
}

export const evaluate = async (options: { base: string; cache?: string }): Promise<Outcome> => {
  const distro = await loadDistro(options.base)
  const report = await runEval({
    questions: distro.questions,
    kb: distro.kb,
    agent: createEvalAgent({ kb: distro.kb }),
    cache: createSqliteStore(options.cache),
    promptVersion: distro.settings.promptVersion,
    model: routeModel(distro.settings.routes, 'eval'),
  })
  return {
    code: report.accuracy === 1 ? 0 : 1,
    lines: [
      ...report.results.map(
        (result) => `${result.pass ? 'pass' : 'FAIL'}  ${result.id}${result.cached ? '  (cached)' : ''}`,
      ),
      `accuracy ${report.accuracy}, ran ${report.ran}, cached ${report.cached}`,
      'note: the scripted runtime only checks the plumbing; accuracy needs a real or replayed runtime',
    ],
  }
}

export const sim = async (options: {
  base: string
  overlays: string
  out: string
  days: number
  seed: number
  recordings?: string
}): Promise<Outcome> => {
  const distro = await loadDistro(options.base)
  const config = { ...defaultSimConfig, ...simSettingsFrom(distro), seed: options.seed, days: options.days }
  const main = await runSimulation({ ...config, events: defaultScenarioEvents })
  const staleness = stalenessTimeline(
    main.discrepancies,
    main.knowledgeProposals,
    main.knowledgeChanges,
    main.knowledgeRejections,
  )
  const cost = await runCostComparison({ ...config, days: Math.min(options.days, 10) })
  const seatMonthlyUsd = 100
  const breakEven = await runBreakEven(config, [20, 40, 80, 160, 320, 640], seatMonthlyUsd)
  const overlayFiles = (await readdir(options.overlays)).filter((name) => name.endsWith('.yaml')).sort()
  const overlays = await Promise.all(
    overlayFiles.map(async (name) => parseOverlay(await readFile(join(options.overlays, name), 'utf8'))),
  )
  const next = demoNextBase(distro)
  const upgrades = await Promise.all(overlays.map((overlay) => checkUpgrade(distro, next, overlay)))
  const recorded = options.recordings ? await readRecordings(options.recordings) : null
  const knowledge = recorded ? await replayKnowledgeEffect(options.base, recorded) : null
  const reports = {
    ...(recorded && knowledge
      ? {
          'report-1-knowledge.md': renderKnowledgeReport(
            knowledge,
            `${recorded.model}, 질문당 ${recorded.runs}회, ${recorded.recordedAt} 녹화의 재생. 시간은 녹화 때만 잰다`,
          ),
        }
      : {}),
    'report-2-approval.md': renderApprovalReport(main.gates, main.approvals, main.ruleChanges),
    'report-3-staleness.md': renderStalenessReport(staleness),
    'report-4-cost.md': renderCostReport(cost),
    'report-5-upgrade.md': renderUpgradeReport(distro.version, next.version, upgrades),
    'report-6-breakeven.md': renderBreakEvenReport(breakEven, seatMonthlyUsd, options.days),
    'reports.json': json({
      seed: options.seed,
      days: options.days,
      summary: summarize(main),
      knowledge,
      approval: approvalCurve(main.gates, main.approvals),
      staleness,
      cost,
      upgrades,
      breakEven,
    }),
  }
  await mkdir(options.out, { recursive: true })
  await Promise.all(Object.entries(reports).map(([name, body]) => writeFile(join(options.out, name), body)))
  return {
    code: 0,
    lines: [
      ...Object.keys(reports).map((name) => `wrote ${join(options.out, name)}`),
      ...(recorded ? [] : ['report 1 needs recordings of a real runtime: see the record command']),
    ],
  }
}
