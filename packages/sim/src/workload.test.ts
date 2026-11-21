import { expect, test } from 'vitest'
import { expectedAt } from './workload.ts'

const expected = {
  system: 'deployer',
  action: 'release',
  params: { svc: 'pay-api', ver: 'v1.0.0', env: 'P' },
}

test('an event changes the expected action only through the column it touches', () => {
  const unrelated = {
    at: 1,
    kind: 'codeChange' as const,
    system: 'incident',
    resource: 'tickets',
    field: 'svc',
    from: 'pay-api',
    to: 'pay-batch',
  }
  const related = {
    at: 1,
    kind: 'codeChange' as const,
    system: 'deployer',
    resource: 'envs',
    field: 'cd',
    from: 'P',
    to: 'PR',
  }
  expect(expectedAt([unrelated], 5, expected)).toEqual(expected)
  expect(expectedAt([related], 5, expected).params.env).toBe('PR')
  expect(expectedAt([related], 0, expected)).toEqual(expected)
})
