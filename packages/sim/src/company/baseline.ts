import type { ActionType, CatalogItem, KnowledgeEntry } from '@crewdesk/core'
import { orgs } from './data.ts'

const mapping = (id: string, taskTypes: string[], data: KnowledgeEntry['data']): KnowledgeEntry => ({
  id,
  kind: 'mapping',
  owner: 'u1001',
  confidence: 'confirmed',
  taskTypes,
  data,
})

export const baselineKnowledge: KnowledgeEntry[] = [
  mapping('role.deployer.deployer', ['access.grant'], {
    concept: 'role',
    scope: 'deployer',
    aliases: ['배포자'],
    value: 'DP',
  }),
  mapping('role.deployer.reader', ['access.grant'], {
    concept: 'role',
    scope: 'deployer',
    aliases: ['조회'],
    value: 'RO',
  }),
  mapping('role.incident.oncall', ['access.grant'], {
    concept: 'role',
    scope: 'incident',
    aliases: ['온콜'],
    value: 'OC',
  }),
  mapping('role.incident.reader', ['access.grant'], {
    concept: 'role',
    scope: 'incident',
    aliases: ['조회'],
    value: 'RO',
  }),
  mapping('role.iam.admin', ['access.grant'], {
    concept: 'role',
    scope: 'iam',
    aliases: ['관리자'],
    value: 'AD',
  }),
  mapping('env.prod', ['deploy.release'], { concept: 'env', aliases: ['운영'], value: 'P' }),
  mapping('env.staging', ['deploy.release'], { concept: 'env', aliases: ['스테이징'], value: 'S' }),
  mapping('severity.s1', ['incident.open'], { concept: 'severity', aliases: ['긴급'], value: 'S1' }),
  mapping('severity.s2', ['incident.open'], { concept: 'severity', aliases: ['높음'], value: 'S2' }),
  mapping('severity.s3', ['incident.open'], { concept: 'severity', aliases: ['보통'], value: 'S3' }),
  ...orgs.map((org) =>
    mapping(`group.${org.code}`, [], { concept: 'group', key: org.code, value: `G-${org.code}` }),
  ),
  {
    id: 'rule.deploy.staging-first',
    kind: 'rule',
    owner: 'u1002',
    confidence: 'confirmed',
    taskTypes: ['deploy.release'],
    data: { concept: 'procedure', before: 'P', requires: 'S' },
  },
]

export const baselineCatalog: CatalogItem[] = [
  {
    domain: 'deploy',
    taskType: 'deploy.release',
    description: '서비스 배포',
    aliases: ['배포 요청', '배포'],
    risk: 'high',
  },
  {
    domain: 'incident',
    taskType: 'incident.open',
    description: '장애 접수',
    aliases: ['장애 접수', '장애'],
    risk: 'medium',
  },
  {
    domain: 'access',
    taskType: 'access.grant',
    description: '권한 부여',
    aliases: ['권한 부여', '권한'],
    risk: 'medium',
  },
]

export const baselineActionTypes: ActionType[] = [
  {
    id: 'iam.grant',
    system: 'iam',
    action: 'grant',
    domain: 'access',
    reversible: true,
    owner: 'u1001',
    approvalLevel: 'always',
    promoteAfter: 5,
    conditionFields: ['sys', 'role_cd'],
    verify: { resource: 'grants', match: ['uid', 'sys', 'role_cd'] },
  },
  {
    id: 'deployer.release',
    system: 'deployer',
    action: 'release',
    domain: 'deploy',
    reversible: false,
    owner: 'u1002',
    approvalLevel: 'always',
    promoteAfter: 8,
    conditionFields: ['env'],
    verify: { resource: 'releases', match: ['svc', 'ver', 'env'] },
  },
  {
    id: 'incident.open',
    system: 'incident',
    action: 'open',
    domain: 'incident',
    reversible: true,
    owner: 'u1003',
    approvalLevel: 'always',
    promoteAfter: 3,
    conditionFields: ['sev'],
    verify: { resource: 'tickets', match: ['svc', 'sev', 'grp'] },
  },
]
