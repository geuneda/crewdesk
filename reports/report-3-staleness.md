# 보고서 3: 지식이 틀려진 시점부터 감지와 수정까지

원천 시스템의 값이 바뀐 시점을 기준으로 잰다. 감지는 실행 중 불일치(runtime) 또는 시스템 변경 이벤트(systemEvent)다.
수정은 평가를 통과한 제안을 담당자가 승인해 반영한 시점이다.

| 지식 항목 | 필드 | 변경 | 틀려진 시점 | 첫 감지 | 감지까지(시간) | 실행 중 보고 수 | 제안까지(시간) | 수정까지(시간) |
|---|---|---|---|---|---|---|---|---|
| role.deployer.deployer | value | DP -> DV | 3일 10시 | runtime | 0.7 | 3 | 14.0 | 23.0 |
| group.PAY | key | PAY -> FIN | 9일 11시 | systemEvent | 13.0 | 0 | 13.0 | 담당자 반려 |
| group.PAY | value | G-PAY -> G-FIN | 9일 11시 | systemEvent | 13.0 | 0 | 13.0 | 22.0 |
| approves.iam.grant | approver | u1001 -> u1005 | 12일 09시 | systemEvent | 15.0 | 0 | 15.0 | 72.0 |
