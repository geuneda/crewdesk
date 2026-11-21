export const companyToolGuide = [
  '사내 시스템은 세 개다. 도구의 system 값으로 쓴다.',
  '- iam(계정 시스템): 자원 accounts(uid, name, org_cd, st), role_codes(sys, cd), grants(uid, sys, role_cd), approvers(action, uid). 액션 grant(uid, sys, role_cd).',
  '- deployer(배포 시스템): 자원 services(svc, owner, tier), envs(cd), releases(svc, ver, env). 액션 release(svc, ver, env).',
  '- incident(장애 관리): 자원 groups(grp, org_cd), severities(cd), tickets(id, svc, sev, grp). 액션 open(svc, sev, grp).',
  'grant 의 sys 값은 권한을 줄 대상 시스템의 이름(iam, deployer, incident)이다.',
].join('\n')
