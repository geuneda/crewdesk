import { DatabaseSync } from 'node:sqlite'
import type { JsonObject, StorePort } from '@crewdesk/core'

export const createSqliteStore = (path = ':memory:'): StorePort => {
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT, body TEXT NOT NULL, UNIQUE (kind, id))',
  )
  const insert = db.prepare('INSERT INTO records (kind, id, body) VALUES (?, ?, ?)')
  const upsert = db.prepare(
    'INSERT INTO records (kind, id, body) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET body = excluded.body',
  )
  const byId = db.prepare('SELECT body FROM records WHERE kind = ? AND id = ?')
  const parse = (row: unknown) => JSON.parse((row as { body: string }).body) as JsonObject

  return {
    append: async (kind, record) => {
      insert.run(kind, null, JSON.stringify(record))
    },
    put: async (kind, id, record) => {
      upsert.run(kind, id, JSON.stringify(record))
    },
    get: async (kind, id) => {
      const row = byId.get(kind, id)
      return row ? parse(row) : null
    },
    list: async (kind, where = {}) => {
      const filters = Object.entries(where)
      const sql = `SELECT body FROM records WHERE kind = ?${filters.map(() => ' AND json_extract(body, ?) = ?').join('')} ORDER BY seq`
      const params = filters.flatMap(([key, value]) => [`$."${key.replaceAll('"', '')}"`, value])
      return db
        .prepare(sql)
        .all(kind, ...params)
        .map(parse)
    },
  }
}
