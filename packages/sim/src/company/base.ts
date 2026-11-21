import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseQuestions, type Question } from '@crewdesk/eval'
import { type KnowledgeBase, loadKnowledge } from '@crewdesk/knowledge'

export const baseDistroDir = fileURLToPath(new URL('../../../../distro/base', import.meta.url))

export const loadBaseKnowledge = (): Promise<KnowledgeBase> => loadKnowledge(`${baseDistroDir}/knowledge`)

export const loadBaseQuestions = async (): Promise<Question[]> =>
  parseQuestions(await readFile(`${baseDistroDir}/eval/questions.yaml`, 'utf8'))
