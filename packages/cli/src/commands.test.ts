import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOverlay, loadDistro, parseOverlay, planUpgrade, snapshotOf } from '@crewdesk/distro'
import { patchEntry } from '@crewdesk/knowledge'
import { baseDistroDir } from '@crewdesk/sim'
import { expect, test } from 'vitest'
import { deploy, evaluate, init, upgrade } from './commands.ts'
import { checkUpgrade, demoNextBase, renderUpgradeReport } from './upgradeReport.ts'

const base = await loadDistro(baseDistroDir)
const overlaysDir = join(baseDistroDir, '..', 'overlays')
const overlayOf = async (org: string) =>
  parseOverlay(await readFile(join(overlaysDir, `${org}.yaml`), 'utf8'))
const temp = () => mkdtemp(join(tmpdir(), 'crewdesk-'))

const nextBaseDir = async (edit: (yaml: string) => string, file = 'distro.yaml') => {
  const dir = join(await temp(), 'base')
  await cp(baseDistroDir, dir, { recursive: true })
  await writeFile(
    join(dir, 'distro.yaml'),
    (await readFile(join(dir, 'distro.yaml'), 'utf8')).replace('version: 1.0.0', 'version: 1.1.0'),
  )
  await writeFile(join(dir, file), edit(await readFile(join(dir, file), 'utf8')))
  return dir
}

test('an overlay overrides settings and knowledge, and unknown entries are refused', async () => {
  const merged = applyOverlay(base, await overlayOf('payments'))
  expect(merged.settings.budget).toEqual({ ...base.settings.budget, turns: 8 })
  expect(merged.kb.entries.find((entry) => entry.id === 'actionType.iam.grant')?.data.promoteAfter).toBe(10)
  expect(() =>
    applyOverlay(base, { org: 'x', baseVersion: '1.0.0', settings: {}, knowledge: { nope: {} } }),
  ).toThrow(/unknown knowledge entry nope/)
  expect(() =>
    applyOverlay(base, {
      org: 'x',
      baseVersion: '1.0.0',
      settings: { budget: { turns: 'many' } },
      knowledge: {},
    }),
  ).toThrow(/settings.budget.turns/)
})

test('a conflict is an overridden value whose base value changed', async () => {
  const next = demoNextBase(base)
  const plan = planUpgrade(snapshotOf(base), snapshotOf(next), await overlayOf('payments'))
  expect(plan).toEqual({
    from: '1.0.0',
    to: '1.1.0',
    conflicts: [{ path: 'knowledge.actionType.iam.grant.promoteAfter', overlay: 10, was: 5, now: 4 }],
  })
  expect(planUpgrade(snapshotOf(base), snapshotOf(next), await overlayOf('live')).conflicts).toEqual([])
  const removed = {
    ...next,
    kb: { entries: next.kb.entries.filter((entry) => entry.id !== 'actionType.iam.grant') },
  }
  expect(
    planUpgrade(snapshotOf(base), snapshotOf(removed), await overlayOf('payments')).conflicts[0],
  ).toMatchObject({
    now: null,
  })
})

test('report 5: per organisation the upgrade is applied, or stopped by a conflict or by eval', async () => {
  const next = demoNextBase(base)
  const outcomes = await Promise.all(
    ['data', 'live', 'payments'].map(async (org) => checkUpgrade(base, next, await overlayOf(org))),
  )
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'applied', 'conflict'])
  expect(outcomes[0]).toMatchObject({ accuracyBefore: 1, accuracyAfter: 1 })
  const broken = { ...next, kb: patchEntry(next.kb, 'env.prod', { value: 'PROD' }) }
  expect((await checkUpgrade(base, broken, await overlayOf('data'))).status).toBe('evalFailed')
  const report = renderUpgradeReport('1.0.0', '1.1.0', outcomes)
  expect(report).toContain('| payments | 충돌로 중단 | 1 |')
  expect(report).toContain('| payments | knowledge.actionType.iam.grant.promoteAfter | 10 | 5 | 4 |')
})

test('init, deploy, then an upgrade that stops on a conflict and passes once it is resolved', async () => {
  const dir = join(await temp(), 'payments')
  expect((await init({ dir, org: 'payments', base: baseDistroDir })).code).toBe(0)
  expect((await init({ dir, org: 'payments', base: baseDistroDir })).code).toBe(1)
  await writeFile(join(dir, 'overlay.yaml'), await readFile(join(overlaysDir, 'payments.yaml'), 'utf8'))
  expect((await deploy({ dir, base: baseDistroDir })).lines[0]).toMatch(/deployed payments at 1.0.0/)
  const resolved = JSON.parse(await readFile(join(dir, 'resolved.json'), 'utf8'))
  expect(resolved).toMatchObject({ org: 'payments', version: '1.0.0', settings: { budget: { turns: 8 } } })
  expect(await readFile(join(dir, 'wiki.md'), 'utf8')).toContain('| role.deployer.deployer |')

  const next = await nextBaseDir(
    (yaml) => yaml.replace('promoteAfter: 5', 'promoteAfter: 4'),
    'knowledge/actions.yaml',
  )
  expect((await deploy({ dir, base: next })).code).toBe(1)
  const stopped = await upgrade({ dir, base: next })
  expect(stopped.code).toBe(1)
  expect(stopped.lines.join('\n')).toContain(
    'knowledge.actionType.iam.grant.promoteAfter: overlay 10, base 5 -> 4',
  )
  expect(JSON.parse(await readFile(join(dir, 'base.lock.json'), 'utf8')).version).toBe('1.0.0')

  await writeFile(
    join(dir, 'overlay.yaml'),
    '# reviewed\norg: payments\nbaseVersion: 1.0.0\nsettings:\n  budget: { turns: 8 }\n',
  )
  expect((await upgrade({ dir, base: next })).lines[0]).toMatch(/upgraded payments 1.0.0 -> 1.1.0/)
  expect(await readFile(join(dir, 'overlay.yaml'), 'utf8')).toMatch(/# reviewed[\s\S]*baseVersion: 1.1.0/)
  expect(JSON.parse(await readFile(join(dir, 'resolved.json'), 'utf8')).version).toBe('1.1.0')
  expect((await upgrade({ dir, base: next })).lines).toEqual(['already at 1.1.0'])
})

test('an upgrade that lowers eval accuracy is stopped and nothing is written', async () => {
  const dir = join(await temp(), 'data')
  await init({ dir, org: 'data', base: baseDistroDir })
  const next = await nextBaseDir(
    (yaml) => yaml.replace('aliases: [운영], value: P', 'aliases: [운영], value: PROD'),
    'knowledge/codes.yaml',
  )
  const stopped = await upgrade({ dir, base: next })
  expect(stopped).toMatchObject({ code: 1 })
  expect(stopped.lines[0]).toMatch(/eval accuracy fell from 1 to/)
  expect(JSON.parse(await readFile(join(dir, 'base.lock.json'), 'utf8')).version).toBe('1.0.0')
})

test('eval reports each question and reuses a cache file', async () => {
  const cache = join(await temp(), 'eval.db')
  const first = await evaluate({ base: baseDistroDir, cache })
  expect(first.code).toBe(0)
  expect(first.lines).toContain('pass  q.deploy.prod')
  expect((await evaluate({ base: baseDistroDir, cache })).lines).toContain('pass  q.deploy.prod  (cached)')
})
