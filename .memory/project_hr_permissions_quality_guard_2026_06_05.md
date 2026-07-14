# HR 권한 설정 + simplify/code-review 하네스 강화 (2026-06-05)

## 요약

- HR에 `owner` 역할과 기능별 권한 모델을 추가했다.
- `/settings`는 조직 설정(사업자/관/팀), `/settings/permissions`는 권한 설정으로 분리했다.
- `canViewPopulationStats`, 학생/출결/상담/수납/급여/직원/권한관리 권한을 `AppUser.permissions`에 추가했다.
- Firestore `HR_users` rules를 owner/director/권한관리 모델에 맞춰 강화했다.
- DB/HR/newDSC/exam 4개 repo의 `firestore.rules`를 동기화했다.
- 공통 pre-commit 품질 가드를 추가해 source/security diff 커밋 전 `/simplify` -> `/code-review` 확인을 강제한다.

## 주요 파일

- DB SSoT:
  - `/Users/jongsooyi/IMPACT7/impact7DB/firestore.rules`
  - `/Users/jongsooyi/IMPACT7/impact7DB/.agents/hooks/impact7-precommit-quality-guard.mjs`
  - `/Users/jongsooyi/IMPACT7/impact7DB/AGENTS.md`
- HR:
  - `/Users/jongsooyi/IMPACT7/impact7HR/src/routes/settings/permissions/+page.svelte`
  - `/Users/jongsooyi/IMPACT7/impact7HR/src/lib/components/settings/SettingsNav.svelte`
  - `/Users/jongsooyi/IMPACT7/impact7HR/src/lib/types/index.ts`
  - `/Users/jongsooyi/IMPACT7/impact7HR/src/lib/firebase/auth.ts`
  - `/Users/jongsooyi/IMPACT7/impact7HR/src/lib/components/layout/Sidebar.svelte`
  - `/Users/jongsooyi/IMPACT7/impact7HR/src/lib/components/layout/TopNav.svelte`
  - `/Users/jongsooyi/IMPACT7/impact7HR/src/lib/components/layout/BottomNav.svelte`
- Rules sync:
  - `/Users/jongsooyi/IMPACT7/impact7HR/firestore.rules`
  - `/Users/jongsooyi/IMPACT7/impact7newDSC/firestore.rules`
  - `/Users/jongsooyi/IMPACT7/impact7exam/firestore.rules`

## 검증

- `npm run check` in impact7HR: 성공.
- `npm run build` in impact7HR: 성공.
- `firebase deploy --only firestore:rules --project impact7db --dry-run` in impact7DB: 성공.
- 4개 repo `firestore.rules` 동일성 확인.
- 4개 repo `git diff --check` 성공.
- 임시 index로 `firestore.rules` 단독 staged 변경이 pre-commit 가드에 차단되고, `--mark` 후 통과하는 것 확인.

## 다음 세션 주의

- 배포 후 실제 HR에서 `/settings/permissions` 접근, 권한 수정, 본인/owner/director 수정 차단을 smoke test하면 좋다.
- DB/DSC/Dashboard의 인원현황 접근 제어는 아직 실제 화면/쿼리 차단까지 이어지지 않았다. 다음 작업은 `canViewPopulationStats`를 각 앱의 인원현황 표시 경계에 적용하는 것이다.
- 이 종류의 크로스앱 rules/harness 작업은 `impact7DB`에서 조율하는 것이 맞다. 단, HR UI 구현과 HR hosting 배포는 `impact7HR` repo에서 관리한다.
