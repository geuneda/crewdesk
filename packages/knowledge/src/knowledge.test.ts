import { expect, test } from 'vitest'
import { entryHash, fragmentFor, lookup, patchEntry } from './query.ts'
import { renderGuide, renderWiki } from './render.ts'
import { actionTypesOf, catalogOf, parseKnowledge } from './schema.ts'

const source = `
entries:
  - id: taskType.access.grant
    kind: entity
    owner: u1
    confidence: confirmed
    data: { type: TaskType, domain: access, taskType: access.grant, description: grant, aliases: [권한], risk: medium }
  - id: actionType.iam.grant
    kind: entity
    owner: u1
    confidence: confirmed
    data:
      type: ActionType
      system: iam
      action: grant
      domain: access
      reversible: true
      approvalLevel: always
      promoteAfter: 5
      conditionFields: [sys]
  - id: role.deployer
    kind: mapping
    owner: u1
    confidence: assumed
    taskTypes: [access.grant]
    evidence: seen in role_codes
    data: { concept: role, scope: deployer, aliases: [배포자], value: DP }
  - id: group.PAY
    kind: mapping
    owner: u1
    confidence: confirmed
    data: { concept: group, key: PAY, value: G-PAY }
`
const kb = parseKnowledge([{ name: 'test.yaml', text: source }])

test('typed entities become the intake catalog and the action types', () => {
  expect(catalogOf(kb)).toEqual([
    { domain: 'access', taskType: 'access.grant', description: 'grant', aliases: ['권한'], risk: 'medium' },
  ])
  expect(actionTypesOf(kb)[0]).toMatchObject({
    id: 'iam.grant',
    owner: 'u1',
    reversible: true,
    promoteAfter: 5,
  })
})

test('the fragment holds only entries tagged with the task type, the rest come from lookup', () => {
  expect(fragmentFor(kb, 'access.grant').map((entry) => entry.id)).toEqual(['role.deployer'])
  expect(lookup(kb, { concept: 'group', key: 'PAY' }).map((entry) => entry.id)).toEqual(['group.PAY'])
  expect(lookup(kb, { concept: 'role', text: '조회 권한' })).toEqual([])
  expect(lookup(kb, { concept: 'role', text: '배포자 권한', scope: 'deployer' })).toHaveLength(1)
})

test('the hash follows content, not metadata', () => {
  const [entry] = lookup(kb, { id: 'group.PAY' })
  const [patched] = lookup(patchEntry(kb, 'group.PAY', { value: 'G-FIN' }), { id: 'group.PAY' })
  if (!entry || !patched) throw new Error('entry missing')
  expect(entryHash({ ...entry, lastVerifiedAt: '2026-01-01', owner: 'u9' })).toBe(entryHash(entry))
  expect(entryHash(patched)).not.toBe(entryHash(entry))
})

test('invalid knowledge is rejected with the file and entry named', () => {
  const broken = (text: string) => () => parseKnowledge([{ name: 'bad.yaml', text }])
  expect(broken('entries: [{ id: a, kind: fact, owner: u, confidence: confirmed, data: {} }]')).toThrow(
    /bad.yaml: a: kind/,
  )
  expect(broken('entries: [{ id: a, kind: rule, owner: u, confidence: confirmed }]')).toThrow(
    /data must be a mapping/,
  )
  expect(broken('items: []')).toThrow(/entries/)
  expect(() =>
    parseKnowledge([
      { name: 'a.yaml', text: source },
      { name: 'b.yaml', text: source },
    ]),
  ).toThrow(/duplicate/)
  expect(
    broken(
      'entries: [{ id: t, kind: entity, owner: u, confidence: confirmed, data: { type: TaskType, domain: hr } }]',
    ),
  ).toThrow(/domain/)
})

test('a verify block must name the fields to match', () => {
  const withVerify = (verify: string) => () =>
    parseKnowledge([
      {
        name: 'v.yaml',
        text: source.replace('conditionFields: [sys]', `conditionFields: [sys]\n      verify: ${verify}`),
      },
    ])
  expect(withVerify('{ resource: grants }')).toThrow(/verify.match/)
  expect(withVerify('grants')).toThrow(/verify must be a mapping/)
  expect(actionTypesOf(withVerify('{ resource: grants, match: [uid] }')())[0]?.verify).toEqual({
    resource: 'grants',
    match: ['uid'],
  })
})

test('documents are generated from the entries', () => {
  expect(renderGuide(fragmentFor(kb, 'access.grant'))).toBe(
    '- [role.deployer] concept="role", scope="deployer", aliases=배포자, value="DP" (추정)',
  )
  const wiki = renderWiki(kb)
  expect(wiki).toContain('| role.deployer |')
  expect(wiki).toContain('seen in role_codes')
  expect(wiki).toContain('## 매핑')
})
