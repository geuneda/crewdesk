export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const isWorkday = (day: number): boolean => day % 7 < 5

export const nextWorkTime = (at: number): number => {
  const day = Math.floor(at / DAY)
  const timeOfDay = at - day * DAY
  if (isWorkday(day) && timeOfDay >= 9 * HOUR && timeOfDay < 18 * HOUR) return at
  const first = isWorkday(day) && timeOfDay < 9 * HOUR ? day : day + 1
  const next = [first, first + 1, first + 2].find(isWorkday) ?? first
  return next * DAY + 9 * HOUR
}
