import { runEval } from '@crewdesk/eval'
import { patchEntry } from '@crewdesk/knowledge'
import { expect, test } from 'vitest'
import { loadBaseKnowledge, loadBaseQuestions } from './company/base.ts'
import { createSqliteStore } from './dummies/store.ts'
import { createEvalAgent } from './evalAgent.ts'

const kb = await loadBaseKnowledge()
const questions = await loadBaseQuestions()
const optionsFor = (base: typeof kb) => ({
  questions,
  kb: base,
  agent: createEvalAgent({ kb: base }),
  promptVersion: 'p1',
  model: 'medium',
})

test('every competency question passes with knowledge and is cached afterwards', async () => {
  const cache = createSqliteStore()
  const first = await runEval({ ...optionsFor(kb), cache })
  expect(first).toMatchObject({ accuracy: 1, ran: questions.length, cached: 0 })
  const second = await runEval({ ...optionsFor(kb), cache })
  expect(second).toMatchObject({ accuracy: 1, ran: 0, cached: questions.length })
})

test('editing one entry reruns only the questions that depend on it', async () => {
  const cache = createSqliteStore()
  await runEval({ ...optionsFor(kb), cache })
  const edited = patchEntry(kb, 'group.PAY', { value: 'G-FIN' })
  const report = await runEval({ ...optionsFor(edited), cache })
  const reran = report.results.filter((result) => !result.cached).map((result) => result.id)
  expect(reran).toEqual(['q.incident.urgent'])
  expect(report.results.find((result) => result.id === 'q.incident.urgent')?.pass).toBe(false)
})

test('editing a fragment entry reruns every question of that task type', async () => {
  const cache = createSqliteStore()
  await runEval({ ...optionsFor(kb), cache })
  const report = await runEval({ ...optionsFor(patchEntry(kb, 'env.prod', { value: 'PR' })), cache })
  expect(report.results.filter((result) => !result.cached).map((result) => result.id)).toEqual([
    'q.deploy.staging',
    'q.deploy.prod',
  ])
})

test('a new model or prompt version, or force, reruns everything', async () => {
  const cache = createSqliteStore()
  await runEval({ ...optionsFor(kb), cache })
  expect((await runEval({ ...optionsFor(kb), cache, model: 'large' })).ran).toBe(questions.length)
  expect((await runEval({ ...optionsFor(kb), cache, model: 'large', promptVersion: 'p2' })).ran).toBe(
    questions.length,
  )
  expect(
    (await runEval({ ...optionsFor(kb), cache, model: 'large', promptVersion: 'p2', force: true, runs: 3 }))
      .ran,
  ).toBe(questions.length)
})

test('without knowledge every code value question fails', async () => {
  const empty = { entries: kb.entries.filter((entry) => entry.kind === 'entity') }
  const report = await runEval({ ...optionsFor(empty), cache: createSqliteStore() })
  expect(report.accuracy).toBe(0)
})

test('zero runs is an error and a one-run result is not reused for three runs', async () => {
  const cache = createSqliteStore()
  await expect(runEval({ ...optionsFor(kb), cache, runs: 0 })).rejects.toThrow(/runs must be/)
  await runEval({ ...optionsFor(kb), cache })
  expect((await runEval({ ...optionsFor(kb), cache, runs: 3 })).ran).toBe(questions.length)
})

test('removing the task type of a cached question is reported, not served from cache', async () => {
  const cache = createSqliteStore()
  await runEval({ ...optionsFor(kb), cache })
  const without = { entries: kb.entries.filter((entry) => entry.id !== 'taskType.deploy.release') }
  await expect(runEval({ ...optionsFor(without), cache })).rejects.toThrow(/unknown task type deploy.release/)
})
