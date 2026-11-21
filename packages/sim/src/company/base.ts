import { fileURLToPath } from 'node:url'
import { loadDistro } from '@crewdesk/distro'
import type { Question } from '@crewdesk/eval'
import type { KnowledgeBase } from '@crewdesk/knowledge'

export const baseDistroDir = fileURLToPath(new URL('../../../../distro/base', import.meta.url))

export const baseDistro = await loadDistro(baseDistroDir)

export const loadBaseKnowledge = async (): Promise<KnowledgeBase> => baseDistro.kb

export const loadBaseQuestions = async (): Promise<Question[]> => baseDistro.questions
