# 보고서 2: 승인 요청 비율

액션 중 사람의 승인을 요청한 비율이다. 같은 조건이 수정 없이 연속 승인되면 규칙이 한 단계씩 올라간다.

## 주별

| 주 | 액션 수 | 승인 요청 비율 |
|---|---|---|
| 1 | 152 | 0.93 |
| 2 | 183 | 0.64 |
| 3 | 162 | 0.4 |
| 4 | 151 | 0.5 |
| 5 | 66 | 0.26 |

## 일별

| 일 | 액션 수 | 승인 요청 | 비율 | 결정된 건의 대기 중앙값(분) |
|---|---|---|---|---|
| 1 | 28 | 28 | 1 | 127.9 |
| 2 | 37 | 37 | 1 | 113.6 |
| 3 | 31 | 31 | 1 | 106.9 |
| 4 | 28 | 24 | 0.86 | 21.3 |
| 5 | 28 | 21 | 0.75 | 9.7 |
| 8 | 35 | 34 | 0.97 | 12.7 |
| 9 | 38 | 29 | 0.76 | 14.3 |
| 10 | 37 | 18 | 0.49 | 19.2 |
| 11 | 33 | 15 | 0.45 | 58.7 |
| 12 | 39 | 20 | 0.51 | 14.4 |
| 13 | 1 | 1 | 1 | 3420 |
| 15 | 31 | 6 | 0.19 | 12.5 |
| 16 | 31 | 13 | 0.42 | 7 |
| 17 | 36 | 18 | 0.5 | 15.3 |
| 18 | 33 | 18 | 0.55 | 11.9 |
| 19 | 31 | 10 | 0.32 | 10.5 |
| 22 | 31 | 18 | 0.58 | 13.2 |
| 23 | 31 | 14 | 0.45 | 7.1 |
| 24 | 36 | 18 | 0.5 | 10.4 |
| 25 | 24 | 11 | 0.46 | 11.1 |
| 26 | 29 | 15 | 0.52 | 7.9 |
| 29 | 36 | 9 | 0.25 | 9.3 |
| 30 | 30 | 8 | 0.27 | 14.2 |

## 규칙 변경

| 일 | 액션 타입 | 조건 | 변경 | 원인 |
|---|---|---|---|---|
| 2 | deployer.release | env="S" | always -> recommend | promotion |
| 2 | deployer.release | env="S" | recommend -> always | rejection |
| 3 | iam.grant | sys="deployer"&role_cd="DP" | always -> recommend | promotion |
| 3 | incident.open | sev="S3" | always -> recommend | promotion |
| 4 | iam.grant | sys="incident"&role_cd="OC" | always -> recommend | promotion |
| 4 | deployer.release | env="S" | always -> recommend | promotion |
| 4 | incident.open | sev="S2" | always -> recommend | promotion |
| 4 | incident.open | sev="S3" | recommend -> notify | promotion |
| 5 | iam.grant | sys="deployer"&role_cd="RO" | always -> recommend | promotion |
| 5 | deployer.release | env="P" | always -> recommend | promotion |
| 5 | incident.open | sev="S3" | notify -> auto | promotion |
| 5 | incident.open | sev="S1" | always -> recommend | promotion |
| 9 | iam.grant | sys="incident"&role_cd="OC" | recommend -> notify | promotion |
| 9 | iam.grant | sys="deployer"&role_cd="RO" | recommend -> notify | promotion |
| 9 | iam.grant | sys="deployer"&role_cd="DV" | always -> recommend | promotion |
| 9 | incident.open | sev="S2" | recommend -> notify | promotion |
| 9 | incident.open | sev="S1" | recommend -> notify | promotion |
| 9 | deployer.release | env="S" | recommend -> always | rejection |
| 10 | iam.grant | sys="incident"&role_cd="RO" | always -> recommend | promotion |
| 10 | iam.grant | sys="deployer"&role_cd="DV" | recommend -> notify | promotion |
| 11 | iam.grant | sys="deployer"&role_cd="RO" | notify -> auto | promotion |
| 11 | deployer.release | env="S" | always -> recommend | promotion |
| 11 | incident.open | sev="S2" | notify -> auto | promotion |
| 11 | incident.open | sev="S1" | notify -> auto | promotion |
| 11 | deployer.release | env="S" | recommend -> always | rejection |
| 12 | iam.grant | sys="incident"&role_cd="OC" | notify -> auto | promotion |
| 12 | iam.grant | sys="deployer"&role_cd="DV" | notify -> auto | promotion |
| 12 | deployer.release | env="S" | always -> recommend | promotion |
| 15 | iam.grant | sys="incident"&role_cd="RO" | recommend -> notify | promotion |
| 18 | iam.grant | sys="incident"&role_cd="RO" | notify -> auto | promotion |
