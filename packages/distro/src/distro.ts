import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, type Json, type JsonObject } from '@crewdesk/core'
import { parseQuestions, type Question } from '@crewdesk/eval'
import { entryHash, hashOf, type KnowledgeBase, loadKnowledge, patchEntry } from '@crewdesk/knowledge'
import { parse } from 'yaml'
import { isObject, type Settings, toSettings } from './settings.ts'

export type Distro = {
  name: string
  version: string
  settings: Settings
  kb: KnowledgeBase
  questions: Question[]
  prompts: Record<string, string>
}

export type Overlay = {
  org: string
  baseVersion: string
  settings: JsonObject
  knowledge: Record<string, JsonObject>
}

export type Snapshot = { version: string; settings: JsonObject; knowledge: Record<string, JsonObject> }

export type Conflict = { path: string; overlay: Json; was: Json | null; now: Json | null }
export type UpgradePlan = { from: string; to: string; conflicts: Conflict[] }

const named = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} must be a non-empty string`)
  return value
}

export const loadDistro = async (dir: string): Promise<Distro> => {
  const manifest: unknown = parse(await readFile(join(dir, 'distro.yaml'), 'utf8'))
  if (!isObject(manifest)) throw new Error('distro.yaml must be a mapping')
  const promptFiles = (await readdir(join(dir, 'prompts'))).filter((name) => name.endsWith('.md')).sort()
  const prompts = await Promise.all(
    promptFiles.map(async (name) => [
      name.replace(/\.md$/, ''),
      await readFile(join(dir, 'prompts', name), 'utf8'),
    ]),
  )
  return {
    name: named(manifest.name, 'distro.yaml: name'),
    version: named(manifest.version, 'distro.yaml: version'),
    settings: toSettings(manifest.settings),
    kb: await loadKnowledge(join(dir, 'knowledge')),
    questions: parseQuestions(await readFile(join(dir, 'eval', 'questions.yaml'), 'utf8')),
    prompts: Object.fromEntries(prompts),
  }
}

export const parseOverlay = (text: string): Overlay => {
  const raw: unknown = parse(text)
  if (!isObject(raw)) throw new Error('an overlay must be a mapping')
  const settings = raw.settings ?? {}
  const knowledge = raw.knowledge ?? {}
  if (!isObject(settings)) throw new Error('overlay settings must be a mapping')
  if (!isObject(knowledge) || !Object.values(knowledge).every(isObject)) {
    throw new Error('overlay knowledge must map entry ids to data fields')
  }
  return {
    org: named(raw.org, 'overlay org'),
    baseVersion: named(raw.baseVersion, 'overlay baseVersion'),
    settings,
    knowledge: knowledge as Record<string, JsonObject>,
  }
}

const merge = (base: Json, over: Json): Json =>
  isObject(base) && isObject(over)
    ? Object.fromEntries(
        [...new Set([...Object.keys(base), ...Object.keys(over)])].map((key) => {
          const mine = base[key]
          const theirs = over[key]
          return [
            key,
            theirs === undefined ? (mine ?? null) : mine === undefined ? theirs : merge(mine, theirs),
          ]
        }),
      )
    : over

export const applyOverlay = (base: Distro, overlay: Overlay): Distro => {
  const unknown = Object.keys(overlay.knowledge).find(
    (id) => !base.kb.entries.some((entry) => entry.id === id),
  )
  if (unknown) throw new Error(`overlay ${overlay.org} patches an unknown knowledge entry ${unknown}`)
  return {
    ...base,
    settings: toSettings(merge(base.settings as unknown as Json, overlay.settings)),
    kb: Object.entries(overlay.knowledge).reduce((kb, [id, data]) => patchEntry(kb, id, data), base.kb),
  }
}

export const snapshotOf = (distro: Distro): Snapshot => ({
  version: distro.version,
  settings: distro.settings as unknown as JsonObject,
  knowledge: Object.fromEntries(distro.kb.entries.map((entry) => [entry.id, entry.data])),
})

export const knowledgeHash = (kb: KnowledgeBase): string =>
  hashOf(kb.entries.map((entry) => [entry.id, entryHash(entry)]))

const leaves = (value: Json, path: string[]): { path: string[]; value: Json }[] =>
  isObject(value)
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]))
    : [{ path, value }]

const at = (root: Json | undefined, path: string[]): Json | undefined =>
  path.reduce<Json | undefined>((node, key) => (isObject(node) ? node[key] : undefined), root)

export const planUpgrade = (was: Snapshot, now: Snapshot, overlay: Overlay): UpgradePlan => {
  const overridden = [
    ...leaves(overlay.settings, []).map((leaf) => ({ ...leaf, root: 'settings' as const })),
    ...Object.entries(overlay.knowledge).flatMap(([id, data]) =>
      leaves(data, []).map((leaf) => ({ ...leaf, path: [id, ...leaf.path], root: 'knowledge' as const })),
    ),
  ]
  return {
    from: was.version,
    to: now.version,
    conflicts: overridden.flatMap((leaf) => {
      const before = at(was[leaf.root], leaf.path)
      const after = at(now[leaf.root], leaf.path)
      const same =
        before !== undefined && after !== undefined && canonicalJson(before) === canonicalJson(after)
      return same || (before === undefined && after === undefined)
        ? []
        : [
            {
              path: [leaf.root, ...leaf.path].join('.'),
              overlay: leaf.value,
              was: before ?? null,
              now: after ?? null,
            },
          ]
    }),
  }
}
