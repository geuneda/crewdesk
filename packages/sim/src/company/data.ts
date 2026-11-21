import type { Db } from '../dummies/systems.ts'

export const orgs = [
  { code: 'PLT', name: '플랫폼팀' },
  { code: 'PAY', name: '결제팀' },
  { code: 'LIV', name: '라이브운영팀' },
  { code: 'DAT', name: '데이터팀' },
]

const surnames = ['김', '이', '박', '최', '정', '강']
const givenNames = ['민준', '서연', '도윤', '하은']

export const people = surnames.flatMap((surname, i) =>
  givenNames.map((given, j) => {
    const index = i * givenNames.length + j
    return {
      uid: `u${1001 + index}`,
      name: surname + given,
      org: orgs[index % orgs.length]?.code ?? 'PLT',
      lead: index < orgs.length,
    }
  }),
)

export const services = [
  { svc: 'pay-api', owner: 'PAY', tier: 'T1' },
  { svc: 'pay-batch', owner: 'PAY', tier: 'T2' },
  { svc: 'live-gateway', owner: 'LIV', tier: 'T1' },
  { svc: 'live-event', owner: 'LIV', tier: 'T2' },
  { svc: 'data-pipeline', owner: 'DAT', tier: 'T2' },
  { svc: 'data-mart', owner: 'DAT', tier: 'T3' },
  { svc: 'plt-auth', owner: 'PLT', tier: 'T1' },
  { svc: 'plt-legacy', owner: 'OLD', tier: 'T3' },
]

export const systemAliases: Record<string, string> = {
  '배포 시스템': 'deployer',
  '장애 관리': 'incident',
  '계정 시스템': 'iam',
}

export const buildCompanyDb = (): Db => ({
  iam: {
    accounts: [
      ...people.map((person) => ({ uid: person.uid, name: person.name, org_cd: person.org, st: 'A' })),
      { uid: 'u0900', name: '한퇴사', org_cd: 'OLD', st: 'X' },
    ],
    role_codes: [
      { sys: 'deployer', cd: 'DP' },
      { sys: 'deployer', cd: 'RO' },
      { sys: 'incident', cd: 'OC' },
      { sys: 'incident', cd: 'RO' },
      { sys: 'iam', cd: 'AD' },
    ],
    grants: [],
    approvers: [
      { action: 'iam.grant', uid: 'u1001' },
      { action: 'deployer.release', uid: 'u1002' },
      { action: 'incident.open', uid: 'u1003' },
    ],
  },
  deployer: {
    services,
    envs: [{ cd: 'P' }, { cd: 'S' }],
    releases: [],
  },
  incident: {
    groups: orgs.map((org) => ({ grp: `G-${org.code}`, org_cd: org.code })),
    severities: [{ cd: 'S1' }, { cd: 'S2' }, { cd: 'S3' }],
    tickets: [],
  },
})
