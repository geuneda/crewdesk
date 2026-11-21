import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type KnowledgeBase, parseKnowledge } from './schema.ts'

export const loadKnowledge = async (dir: string): Promise<KnowledgeBase> => {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.yaml')).sort()
  return parseKnowledge(
    await Promise.all(names.map(async (name) => ({ name, text: await readFile(join(dir, name), 'utf8') }))),
  )
}
