import type { KnowledgeEntry } from '@crewdesk/core'
import type { KnowledgeBase } from './schema.ts'

const titles = { entity: '엔티티', relation: '관계', mapping: '매핑', rule: '규칙' }

const cell = (value: unknown) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')

const facts = (entry: KnowledgeEntry) =>
  Object.entries(entry.data)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : JSON.stringify(value)}`)
    .join(', ')

export const renderGuide = (entries: KnowledgeEntry[]): string =>
  entries
    .map((entry) => `- [${entry.id}] ${facts(entry)}${entry.confidence === 'assumed' ? ' (추정)' : ''}`)
    .join('\n')

export const renderWiki = (kb: KnowledgeBase): string =>
  [
    '# 업무 지식',
    '',
    '이 문서는 지식 YAML에서 생성한다. 직접 고치지 않는다.',
    ...(Object.keys(titles) as (keyof typeof titles)[]).flatMap((kind) => {
      const rows = kb.entries.filter((entry) => entry.kind === kind)
      return rows.length === 0
        ? []
        : [
            '',
            `## ${titles[kind]}`,
            '',
            '| ID | 내용 | 담당 | 신뢰도 | 근거 |',
            '|---|---|---|---|---|',
            ...rows.map(
              (entry) =>
                `| ${cell(entry.id)} | ${cell(facts(entry))} | ${cell(entry.owner)} | ${entry.confidence === 'assumed' ? '추정' : '확정'} | ${cell(entry.evidence ?? '')} |`,
            ),
          ]
    }),
    '',
  ].join('\n')
