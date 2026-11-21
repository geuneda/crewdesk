import { expect, test } from 'vitest'
import { version } from './index.ts'

test('core exposes a version', () => {
  expect(version).toBe('0.0.0')
})
