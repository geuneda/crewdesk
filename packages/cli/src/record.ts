import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type RuntimeEvent, systemClock } from '@crewdesk/core'
import { type Distro, knowledgeHash, loadDistro } from '@crewdesk/distro'
import { hashOf } from '@crewdesk/knowledge'
import { createReplayRuntime, type Recording, recordRuntime } from '@crewdesk/runtime'
import { createClaudeRuntime, type RunAgent } from '@crewdesk/runtime-claude'
import {
  companyToolGuide,
  conditionKey,
  createEvalAgent,
  fakePricing,
  type KnowledgeEffectRow,
  measureKnowledgeEffect,
  renderKnowledgeReport,
} from '@crewdesk/sim'

export type RecordingFile = {
  model: string
  runs: number
  recordedAt: string
  inputHash: string
  recordings: RunRecording[]
}

type RunRecording = Recording & { run: number; attempt: number }

const promptOf = (distro: Distro): string => {
  if (!distro.prompts.work) throw new Error('the distro has no prompts/work.md')
  return `${distro.prompts.work}\n\n${companyToolGuide}`
}

const inputHashOf = (distro: Distro): string =>
  hashOf({ questions: distro.questions, knowledge: knowledgeHash(distro.kb), prompt: promptOf(distro) })

export const realModels: Record<string, string> = {
  small: 'claude-haiku-5-5',
  medium: 'claude-sonnet-5-5',
  large: 'claude-opus-5-5',
}

export const record = async (options: {
  base: string
  out: string
  runs: number
  model: string
  confirmCost: boolean
  run?: RunAgent
}): Promise<{ code: number; lines: string[] }> => {
  const distro = await loadDistro(options.base)
  const calls = distro.questions.length * 2 * options.runs
  const model = realModels[options.model] ?? options.model
  if (!options.confirmCost) {
    return {
      code: 1,
      lines: [
        `this runs ${model} ${calls} times (${distro.questions.length} questions x 2 conditions x ${options.runs} runs) and is billed`,
        'run it again with --confirm-cost once the cost is approved',
      ],
    }
  }
  let recordings: RunRecording[] = []
  let started = 0
  const claude = createClaudeRuntime({
    systemPrompt: promptOf(distro),
    models: realModels,
    ...(options.run ? { run: options.run } : {}),
  })
  const recorderFor = (run: number) => {
    let attempts = 0
    return recordRuntime(claude, conditionKey, (recording) => {
      recordings = [...recordings, { ...recording, run, attempt: attempts++ }]
    })
  }
  const rows = await measureKnowledgeEffect({
    kb: distro.kb,
    questions: distro.questions,
    runs: options.runs,
    model: options.model,
    clock: systemClock,
    pricing: {},
    agentFor: (kb, recordUsage) =>
      createEvalAgent({ kb, clock: systemClock, runtime: recorderFor(started++), recordUsage }),
  })
  const file: RecordingFile = {
    model,
    runs: options.runs,
    recordedAt: new Date(systemClock.now()).toISOString(),
    inputHash: inputHashOf(distro),
    recordings,
  }
  await mkdir(options.out, { recursive: true })
  await writeFile(join(options.out, 'recordings.json'), `${JSON.stringify(file)}\n`)
  await writeFile(
    join(options.out, 'report-1-knowledge.md'),
    renderKnowledgeReport(rows, `${model}, 질문당 ${options.runs}회, 실제 실행 ${file.recordedAt}`),
  )
  return {
    code: 0,
    lines: [
      `recorded ${started} runs on ${model}`,
      `wrote ${join(options.out, 'recordings.json')}`,
      `wrote ${join(options.out, 'report-1-knowledge.md')}`,
    ],
  }
}

const isEvent = (value: unknown): value is RuntimeEvent =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'

export const readRecordings = async (path: string): Promise<RecordingFile> => {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  const file = raw as Partial<RecordingFile>
  if (
    typeof file !== 'object' ||
    file === null ||
    typeof file.model !== 'string' ||
    typeof file.runs !== 'number' ||
    typeof file.recordedAt !== 'string' ||
    typeof file.inputHash !== 'string' ||
    !Array.isArray(file.recordings) ||
    !file.recordings.every(
      (item) =>
        typeof item?.key === 'string' &&
        typeof item.run === 'number' &&
        typeof item.attempt === 'number' &&
        Array.isArray(item.events) &&
        item.events.every(isEvent),
    )
  ) {
    throw new Error(`${path} is not a recordings file`)
  }
  return file as RecordingFile
}

export const replayKnowledgeEffect = async (
  base: string,
  file: RecordingFile,
): Promise<KnowledgeEffectRow[]> => {
  const distro = await loadDistro(base)
  if (file.inputHash !== inputHashOf(distro)) {
    throw new Error(
      'the recordings were made with other questions, knowledge, or prompt than this distro has',
    )
  }
  const complete = (recording: Recording) => {
    const last = recording.events.at(-1)
    return last?.type === 'done' || last?.type === 'error'
  }
  const expected = ['without', 'with'].flatMap((condition) =>
    distro.questions.flatMap((question) =>
      Array.from({ length: file.runs }, () => `eval-${question.id}|${condition}`),
    ),
  )
  const takesOf = (run: number) =>
    file.recordings.filter((item) => item.run === run).sort((a, b) => a.attempt - b.attempt)
  const short = expected.filter((key, run) => {
    const takes = takesOf(run)
    return (
      takes.length === 0 ||
      !takes.every((take, attempt) => take.key === key && take.attempt === attempt && complete(take))
    )
  })
  if (short.length > 0) {
    throw new Error(`the recordings lack complete runs for: ${[...new Set(short)].join(', ')}`)
  }
  let replayed = 0
  const still = { now: () => 0, sleep: async () => {} }
  return measureKnowledgeEffect({
    kb: distro.kb,
    questions: distro.questions,
    runs: file.runs,
    model: file.model,
    clock: still,
    pricing: fakePricing,
    agentFor: (kb, recordUsage) =>
      createEvalAgent({
        kb,
        clock: still,
        runtime: createReplayRuntime(takesOf(replayed++), conditionKey),
        recordUsage,
      }),
  })
}
