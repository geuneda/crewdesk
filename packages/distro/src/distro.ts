import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, type Json, type JsonObject, type KnowledgeEntry } from '@crewdesk/core'
import { parseQuestions, type Question } from '@crewdesk/eval'
import { entryHash, hashOf, type KnowledgeBase, loadKnowledge } from '@crewdesk/knowledge'
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

export type Snapshot = {
  version: string
  settings: JsonObject
  entries: KnowledgeEntry[]
  questions: Question[]
}

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
    kb: {
      entries: base.kb.entries.map((entry) => {
        const patch = overlay.knowledge[entry.id]
        return patch ? { ...entry, data: merge(entry.data, patch) as JsonObject } : entry
      }),
    },
  }
}

export const snapshotOf = (distro: Distro): Snapshot => ({
  version: distro.version,
  settings: distro.settings as unknown as JsonObject,
  entries: distro.kb.entries,
  questions: distro.questions,
})

export const distroFromSnapshot = (snapshot: Snapshot, shell: Distro): Distro => ({
  ...shell,
  version: snapshot.version,
  settings: toSettings(snapshot.settings),
  kb: { entries: snapshot.entries },
  questions: snapshot.questions,
})

export const parseSnapshot = (raw: unknown): Snapshot => {
  if (
    !isObject(raw) ||
    typeof raw.version !== 'string' ||
    !isObject(raw.settings) ||
    !Array.isArray(raw.entries) ||
    !Array.isArray(raw.questions)
  ) {
    throw new Error('base.lock.json is not a valid lock file')
  }
  return raw as unknown as Snapshot
}

export const knowledgeHash = (kb: KnowledgeBase): string =>
  hashOf(kb.entries.map((entry) => [entry.id, entryHash(entry)]))

const leaves = (value: Json, path: string[]): { path: string[]; value: Json }[] =>
  isObject(value) && Object.keys(value).length > 0
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]))
    : [{ path, value }]

const at = (root: Json | undefined, path: string[]): Json | undefined =>
  path.reduce<Json | undefined>((node, key) => (isObject(node) ? node[key] : undefined), root)

const sides = (snapshot: Snapshot) => ({
  settings: snapshot.settings,
  knowledge: Object.fromEntries(snapshot.entries.map((entry) => [entry.id, entry.data])),
})

export const planUpgrade = (was: Snapshot, now: Snapshot, overlay: Overlay): UpgradePlan => {
  const before = sides(was)
  const after = sides(now)
  const overridden = [
    ...leaves(overlay.settings, []).map((leaf) => ({ ...leaf, root: 'settings' as const })),
    ...Object.entries(overlay.knowledge).flatMap(([id, data]) =>
      leaves(data, []).map((leaf) => ({ ...leaf, path: [id, ...leaf.path], root: 'knowledge' as const })),
    ),
  ]
  return {
    from: was.version,
    to: now.version,
    conflicts: overridden
      .map((leaf) => {
        const replaced = leaf.path.findIndex((_, depth) => {
          const prefix = leaf.path.slice(0, depth + 1)
          return [at(before[leaf.root], prefix), at(after[leaf.root], prefix)].some(
            (value) => value !== undefined && !isObject(value),
          )
        })
        const path = replaced < 0 ? leaf.path : leaf.path.slice(0, replaced + 1)
        return { ...leaf, path, value: at(overlay[leaf.root] as Json, path) ?? leaf.value }
      })
      .filter(
        (leaf, index, all) =>
          all.findIndex(
            (other) =>
              JSON.stringify([other.root, ...other.path]) === JSON.stringify([leaf.root, ...leaf.path]),
          ) === index,
      )
      .flatMap((leaf) => {
        const old = at(before[leaf.root], leaf.path)
        const next = at(after[leaf.root], leaf.path)
        const keepsBase =
          isObject(leaf.value) &&
          Object.keys(leaf.value).length === 0 &&
          [old, next].every((value) => value === undefined || isObject(value))
        if (keepsBase) return []
        const same = old !== undefined && next !== undefined && canonicalJson(old) === canonicalJson(next)
        return same || (old === undefined && next === undefined)
          ? []
          : [
              {
                path: [leaf.root, ...leaf.path]
                  .map((segment, depth) =>
                    depth > 0 && !/^[\w-]+$/.test(segment) ? `[${JSON.stringify(segment)}]` : segment,
                  )
                  .join('.'),
                overlay: leaf.value,
                was: old ?? null,
                now: next ?? null,
              },
            ]
      }),
  }
}
