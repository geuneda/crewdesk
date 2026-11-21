import type { Json } from './types.ts'

const sorted = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) => {
        const item = value[key]
        return item === undefined ? [] : [[key, sorted(item)]]
      }),
  )
}

export const canonicalJson = (value: Json): string => JSON.stringify(sorted(value))
