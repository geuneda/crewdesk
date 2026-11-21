import type { SimEvent } from './events.ts'
import { DAY, HOUR } from './time.ts'

export const defaultScenarioEvents: SimEvent[] = [
  {
    at: 2 * DAY + 10 * HOUR,
    kind: 'codeChange',
    system: 'iam',
    resource: 'role_codes',
    field: 'cd',
    from: 'DP',
    to: 'DV',
  },
  { at: 8 * DAY + 11 * HOUR, kind: 'reorg', from: 'PAY', to: 'FIN' },
  {
    at: 11 * DAY + 9 * HOUR,
    kind: 'codeChange',
    system: 'iam',
    resource: 'approvers',
    field: 'uid',
    from: 'u1001',
    to: 'u1005',
  },
]
