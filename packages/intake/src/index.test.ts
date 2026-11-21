import type { CatalogItem, InboundMessage, JsonObject, ModelPort, OutboundMessage } from '@crewdesk/core'
import { expect, test } from 'vitest'
import { handleMessage, type IntakeDeps, passesRuleFilter } from './index.ts'

const message: InboundMessage = {
  id: 'm1',
  channel: 'c',
  thread: 'th',
  sender: 'u1',
  body: '배포 요청합니다',
  mentionsAgent: true,
  isDirect: false,
  at: 0,
}
const catalog: CatalogItem[] = [
  { domain: 'deploy', taskType: 'deploy.release', description: '', aliases: ['배포'], risk: 'high' },
]
const usage = { model: '', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }

const setup = (confidenceByModel: Record<string, number>) => {
  const classified: string[] = []
  const sent: OutboundMessage[] = []
  const stored: JsonObject[] = []
  const model: ModelPort = {
    classify: async ({ model: name }) => {
      classified.push(name)
      return {
        classification: { domain: 'deploy', taskType: 'deploy.release', risk: 'high', urgency: 'normal' },
        confidence: confidenceByModel[name] ?? 0,
        usage: { ...usage, model: name },
      }
    },
    reply: async () => ({ text: '', usage }),
  }
  const deps: IntakeDeps = {
    channel: { poll: async () => [], send: async (out) => void sent.push(out) },
    model,
    store: {
      append: async () => {},
      put: async (_, __, record) => void stored.push(record),
      get: async () => null,
      list: async () => [],
    },
    clock: { now: () => 5, sleep: async () => {} },
    catalog: () => catalog,
    models: { cheap: 'small', strong: 'medium' },
    confidenceThreshold: 0.7,
    budget: { tokens: 1, turns: 1, subagents: 0 },
    agentFor: (domain) => `agent-${domain}`,
    recordUsage: async () => {},
  }
  return { deps, classified, sent, stored }
}

test('the rule filter passes mentions, direct messages, and active threads only', () => {
  const quiet = { ...message, mentionsAgent: false }
  expect(passesRuleFilter(message, new Set())).toBe(true)
  expect(passesRuleFilter({ ...quiet, isDirect: true }, new Set())).toBe(true)
  expect(passesRuleFilter(quiet, new Set(['th']))).toBe(true)
  expect(passesRuleFilter(quiet, new Set())).toBe(false)
})

test('filtered messages never reach the model', async () => {
  const { deps, classified } = setup({ small: 0.9 })
  expect(await handleMessage(deps, { ...message, mentionsAgent: false }, new Set())).toBeNull()
  expect(classified).toEqual([])
})

test('a confident cheap classification creates a task and acknowledges it', async () => {
  const { deps, classified, sent, stored } = setup({ small: 0.9 })
  const task = await handleMessage(deps, message, new Set())
  expect(classified).toEqual(['small'])
  expect(task).toMatchObject({ id: 'task-m1', domain: 'deploy', status: 'received', createdAt: 5 })
  expect(stored).toHaveLength(1)
  expect(sent[0]?.body).toContain('agent-deploy')
})

test('low confidence escalates to the stronger model', async () => {
  const { deps, classified } = setup({ small: 0.5, medium: 0.9 })
  await handleMessage(deps, message, new Set())
  expect(classified).toEqual(['small', 'medium'])
})
