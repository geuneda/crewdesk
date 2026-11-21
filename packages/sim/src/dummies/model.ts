import type { CatalogItem, Classification, ModelPort, ModelUsage } from '@crewdesk/core'

const tokens = (text: string) => Math.ceil(text.length / 4)

const urgentWords = ['긴급', '급합니다', 'urgent', 'asap']

export const createRuleModel = (options: { strongModels: string[] }): ModelPort => ({
  classify: async ({ model, body, catalog }) => {
    const lower = body.toLowerCase()
    const scored = catalog
      .map((item) => ({
        item,
        hits: item.aliases.filter((alias) => lower.includes(alias.toLowerCase())).length,
      }))
      .filter((entry) => entry.hits > 0)
    const usage: ModelUsage = {
      model,
      inputTokens: tokens(body) + tokens(JSON.stringify(catalog)),
      outputTokens: 30,
      cachedTokens: 0,
    }
    const first = scored[0]
    if (!first) return { classification: null, confidence: 0.9, usage }
    const strong = options.strongModels.includes(model)
    const best = strong ? scored.reduce((a, b) => (b.hits > a.hits ? b : a)) : first
    const toClassification = (item: CatalogItem): Classification => ({
      domain: item.domain,
      taskType: item.taskType,
      risk: item.risk,
      urgency: urgentWords.some((word) => lower.includes(word)) ? 'high' : 'normal',
    })
    return {
      classification: toClassification(best.item),
      confidence: scored.length === 1 || strong ? 0.9 : 0.5,
      usage,
    }
  },
  reply: async ({ model, task, outcome, facts }) => {
    const text =
      outcome === 'done'
        ? `요청하신 업무(${task.taskType})를 처리했습니다.`
        : `요청하신 업무(${task.taskType})를 담당자에게 넘겼습니다.`
    return {
      text,
      usage: {
        model,
        inputTokens: tokens(task.body) + tokens(JSON.stringify(facts)),
        outputTokens: tokens(text),
        cachedTokens: 0,
      },
    }
  },
})
