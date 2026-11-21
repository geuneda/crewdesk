import type { RandomPort } from './ports.ts'

export const randomInt = (random: RandomPort, min: number, max: number): number =>
  min + Math.floor(random.next() * (max - min + 1))

export const pick = <T>(random: RandomPort, items: readonly T[]): T => {
  const item = items[Math.floor(random.next() * items.length)]
  if (item === undefined) throw new Error('pick from empty list')
  return item
}

export const chance = (random: RandomPort, probability: number): boolean => random.next() < probability
