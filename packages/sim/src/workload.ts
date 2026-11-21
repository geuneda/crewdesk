import type { DomainAction, InboundMessage, RandomPort } from '@crewdesk/core'
import { chance, pick, randomInt } from '@crewdesk/core'
import { people, services } from './company/data.ts'
import type { SimEvent } from './events.ts'
import { DAY, HOUR } from './time.ts'

export type WorkItem = { message: InboundMessage; expected: DomainAction | null }

export type WorkloadConfig = {
  days: number
  requestsPerDay: number
  chatterRatio: number
  events: SimEvent[]
}

const grants = [
  { sys: 'deployer', system: '배포 시스템', role: '배포자', cd: 'DP', weight: 4 },
  { sys: 'deployer', system: '배포 시스템', role: '조회', cd: 'RO', weight: 3 },
  { sys: 'incident', system: '장애 관리', role: '온콜', cd: 'OC', weight: 2 },
  { sys: 'incident', system: '장애 관리', role: '조회', cd: 'RO', weight: 2 },
  { sys: 'iam', system: '계정 시스템', role: '관리자', cd: 'AD', weight: 1 },
]
const envs = [
  { alias: '스테이징', cd: 'S', weight: 3 },
  { alias: '운영', cd: 'P', weight: 2 },
]
const severities = [
  { alias: '긴급', cd: 'S1', weight: 3 },
  { alias: '높음', cd: 'S2', weight: 7 },
  { alias: '보통', cd: 'S3', weight: 10 },
]
const chatter = ['점심 뭐 드실래요', '회의실 예약했습니다', '어제 공유한 문서 확인 부탁드려요']
const linkedServices = services.filter((service) => service.owner !== 'OLD')

const weighted = <T extends { weight: number }>(random: RandomPort, items: T[]): T =>
  pick(
    random,
    items.flatMap((item) => Array.from({ length: item.weight }, () => item)),
  )

const request = (random: RandomPort): { body: string; expected: DomainAction } => {
  const roll = random.next()
  if (roll < 0.45) {
    const grant = weighted(random, grants)
    const target = pick(random, people)
    return {
      body: `${target.name}님에게 ${grant.system} ${grant.role} 권한 부여 부탁드립니다`,
      expected: {
        system: 'iam',
        action: 'grant',
        params: { uid: target.uid, sys: grant.sys, role_cd: grant.cd },
      },
    }
  }
  if (roll < 0.75) {
    const env = weighted(random, envs)
    const svc = pick(random, linkedServices).svc
    const ver = `v${randomInt(random, 1, 3)}.${randomInt(random, 0, 20)}.${randomInt(random, 0, 9)}`
    return {
      body: `${svc} ${ver} ${env.alias} 배포 요청합니다`,
      expected: { system: 'deployer', action: 'release', params: { svc, ver, env: env.cd } },
    }
  }
  const severity = weighted(random, severities)
  const service = pick(random, linkedServices)
  return {
    body: `${service.svc} 장애 접수합니다. 심각도 ${severity.alias}`,
    expected: {
      system: 'incident',
      action: 'open',
      params: { svc: service.svc, sev: severity.cd, grp: `G-${service.owner}` },
    },
  }
}

const paramSources: Record<string, string> = {
  role_cd: 'iam/role_codes/cd',
  env: 'deployer/envs/cd',
  sev: 'incident/severities/cd',
  grp: 'incident/groups/grp',
  svc: 'deployer/services/svc',
}

const renamed = (events: SimEvent[], at: number, param: string, value: string): string =>
  events.reduce((current, event) => {
    if (event.at > at) return current
    if (
      event.kind === 'codeChange' &&
      current === event.from &&
      paramSources[param] === `${event.system}/${event.resource}/${event.field}`
    ) {
      return event.to
    }
    if (event.kind === 'reorg' && param === 'grp' && current === `G-${event.from}`) return `G-${event.to}`
    return current
  }, value)

export const expectedAt = (events: SimEvent[], at: number, expected: DomainAction): DomainAction => ({
  ...expected,
  params: Object.fromEntries(
    Object.entries(expected.params).map(([key, value]) => [
      key,
      typeof value === 'string' ? renamed(events, at, key, value) : value,
    ]),
  ),
})

const workTimes = (random: RandomPort, config: WorkloadConfig): number[] => {
  const daily = Array.from({ length: config.days }, (_, day) => day)
    .filter((day) => day % 7 < 5)
    .flatMap((day) =>
      Array.from({ length: Math.round(config.requestsPerDay * (0.8 + 0.4 * random.next())) }, () =>
        Math.floor(day * DAY + 9 * HOUR + random.next() * 9 * HOUR),
      ),
    )
  const bursts = config.events.flatMap((event) =>
    event.kind === 'burst'
      ? Array.from(
          {
            length: Math.round(
              ((config.requestsPerDay * (event.factor - 1)) / (9 * HOUR)) * event.durationMs,
            ),
          },
          () => Math.floor(event.at + random.next() * event.durationMs),
        )
      : [],
  )
  return [...daily, ...bursts].sort((a, b) => a - b)
}

export const generateWorkload = (random: RandomPort, config: WorkloadConfig): WorkItem[] => {
  const ordered = [...config.events].sort((a, b) => a.at - b.at)
  const times = workTimes(random, config).filter((at) => at < config.days * DAY)
  return times.map((at, index) => {
    const sender = pick(random, people).uid
    const base = { id: `m${index + 1}`, channel: 'infra-requests', thread: `th${index + 1}`, sender, at }
    if (chance(random, config.chatterRatio)) {
      return {
        message: { ...base, body: pick(random, chatter), mentionsAgent: false, isDirect: false },
        expected: null,
      }
    }
    const { body, expected } = request(random)
    const direct = chance(random, 0.2)
    return {
      message: { ...base, body, mentionsAgent: !direct, isDirect: direct },
      expected: expectedAt(ordered, at, expected),
    }
  })
}
