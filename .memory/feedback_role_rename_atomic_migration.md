---
name: feedback-role-rename-atomic-migration
description: 역할값 등 어휘 리네임은 rules 배포 + 데이터 마이그레이션 + 4-repo 사본 동기화를 한 작업으로 — 2026-06-12 HR 원장 RBAC 역전 먹통 사고
metadata:
  type: feedback
---

역할값(또는 rules가 참조하는 모든 데이터 어휘)을 리네임할 때는 ①rules 배포, ②기존 Firestore 데이터 마이그레이션, ③4-repo 사본 동기화를 **하나의 원자적 작업**으로 묶고, 배포 직후 실계정으로 권한 smoke test를 한다.

**Why:** 2026-06-12 HR 프로덕션 먹통 사고. 6/11 director→principal 리네임에서 rules는 SSoT(impact7DB, aba1cd6)에서 배포됐지만 — 커밋 메시지에 "단독 배포 시 RBAC 역전" 경고까지 있었음에도 — 원장 계정의 `HR_users.role` 데이터가 구 값 `'director'`로 남아 원장이 비인가로 역전됐다. 계약서 collectionGroup 읽기가 전부 permission-denied가 됐고, contracts 스토어의 onSnapshot에 에러 콜백이 없어 권한 거부가 침묵 → 로딩 스켈레톤 영구 고착("첫화면 먹통"). 같은 시간대에 배포된 UI 배치가 원인으로 오인돼 진단이 늦어졌다. 추가로 사본 동기화도 DSC만 되고 HR·exam은 누락돼 있었다(장애 원인은 아니나 같은 작업에서 발견).

**How to apply:**
- 어휘 리네임 커밋에는 데이터 마이그레이션 스크립트 실행(또는 동시 PR)을 포함하고, 배포 체크리스트에 "영향 role 실계정 로그인 확인"을 넣는다.
- rules 변경 후 `diff`로 4-repo(impact7DB/newDSC/HR/exam) 사본 0줄 차이를 확인한다 ([[feedback-rules-sync-commit]] 규율).
- 모든 onSnapshot/리스너에는 에러 콜백 필수 — 권한 거부가 침묵하면 장애가 "먹통"으로 위장된다 (HR `8a6506a`에서 가드 추가).
- 장애 원인 추정 시 "직전 배포 = 원인" 가정 금지: rules·데이터·코드 세 축을 각각 확인 (이번엔 코드 무죄, 데이터+rules 불일치가 원인).
