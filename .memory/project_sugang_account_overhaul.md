# 수강계정 개편 (2026-07-23, 진행 중 — 코드·리뷰 완료·릴리스 대기)

## 2026-07-23 마무리 세션 (Claude 오케스트레이션 + Codex 실행)
- 중단 시점 테스트 실패 4건 해결: 복귀 status 재파생(currentStatus는 부분 종료 전용 — 복귀에 넘기면 pause 필드 없는 가휴원 고착), 미래 종료 no-op 정합, scheduledWithdrawals shape, 통합테스트 project ID 불일치(demo-impact7)로 인한 hook timeout.
- Codex 전체 diff 리뷰 15건 처리: CONFIRMED 11건 수정(rules finalize_* create 위조 차단 + account_target 타입 검증, backfill fingerprint 게이트 + 상시 충돌 검사, 복귀 return_date 예약 발효, 복귀 단일 계정 account_target 자동 첨부, 미래 예약 승인 UI 대기 제외, batch 500 write op 기준 분할, CSV import account 검증, verify 스크립트 shared 그룹화 + exit code), REFUTED 2건(특강 ID 충돌 — start_date·semester 포함 + 시기중복 불변식, 정규 단일 계정은 설계), REPORT_ONLY 2건(class_settings 백필은 확정 설계).
- 검증: root 단위 63, rules 168, functions 단위 94 + 통합 28, vite build — 전부 green. 미커밋.

정규계열/특강계열 이분법을 **수강계정**(account) 개념으로 정식화. Claude 오케스트레이션 + Codex 에이전트(라이터·리뷰어·픽서 전원 Codex)로 구현.

## 확정 설계
- enrollments 항목에 `account_id`(불변 UUID)·`account_type`('정규'|'특강'|'기타') 추가. class_type은 수업 형태(정규/내신/자유학기/특강/기타)로 유지 — 두 축 분리. 정규 계정 = 정규+내신+자유학기가 account_id 공유.
- 계정 상태는 저장 안 함 — 날짜로 파생(예정/활성/휴원/종료, accountStateAt). 열린 휴원(종료일 없음) 인정.
- **계정 종료 = 그룹을 배열에서 제거 + history_logs ACCOUNT_END 스냅샷** (배열 보존 방식 기각 — 원시 배열 순회처 전수 수정 위험). 스냅샷 형태 통일: 최상위 { account_id, account_type, account_key, items, end_reason, student_status_before/after, source_request_id }.
- 학생 status 파생: `deriveStudentStatusAfterAccountChange(enrollments, dateStr, {fallbackReason, currentStatus})` — **활성 계정 남고 현재 status가 재원계열이면 보존**(실휴원 학생 부분 종료 시 실휴원 유지). 열린 계정 0이면 사유대로 퇴원/종강.
- leave_requests `account_target` 1필드(map) — 없으면 학생 전체(하위호환). 레거시 계정은 shared group `key`(`legacy:{유형}:{반코드}`)로 지정. 신규 request_type '종강요청'.
- 예약 발효 정본 = 서버 03:10 스케줄러(레거시 scheduled_leave_status·withdrawal_date 단독 문서까지 커버). 클라이언트 발효 writer는 DB·DSC 모두 제거(promoteEnrollPending만 유지). **미래 계정 종료는 학생 문서 no-op** — lr 원장으로만.
- 보류 결정: DSC 계정별 출결(attendance_by_account) 도입 안 함, rules 양방향 불변식(재원→enrollment 필수) 보류.

## 코드 위치 (전부 로컬 미커밋)
- shared v1.48.0(로컬): 계정 계약 11 API + class-code 정책 5 + 파생/이력/사이클 계정화. 407/407, check-drift 통과. 태그 미발행.
- impact7DB worktree(`~/orca/workspaces/impact7DB/수강계정`, 브랜치 chief-impact7/수강계정): enrollment-accounts.js(신규 모듈), class-enrollment-policy=shared 포워더, app.js 계정 쓰기 전환, firestore.rules additive(account_target·class_settings account_type/branch·ACCOUNT_* 3종), functions accountFinalize·스케줄러 확장, scripts/backfill+verify(실행 안 함). 유닛 61+93, 빌드 OK.
- impact7newDSC(master, 미커밋): 마법사 '기타'·특강 폴스루 제거·활성판정 shared 통일·계정 요청서·승인 재검증·closeAccount 편집. 217 테스트, 빌드 OK.
- node_modules 오버레이로 로컬 shared 테스트 중 (3곳: DB root/functions/DSC) — **정식 반영은 태그 후 pin 갱신 필수**.

## 릴리스 순서 (사용자 승인 필요)
1. shared v1.48.0 태그 push → 2. DB·functions·DSC package.json pin 갱신+npm ci 검증 → 3. rules 배포+4-repo 동기화 → 4. functions:leave-request 선배포 → 5. 백필 dry-run→수동 목록 처리→apply→verify → 6. DB 배포 → 7. DSC 배포 → 8. 03:10 스케줄러 실발효 확인.

**Why:** 다계정 학생의 부분 퇴원/종강 표현 부재 + '기타' 계정 필요.
**How to apply:** 이 도메인 후속 작업 시 shared 계정 계약이 SSoT — 로컬 활성판정 재구현 금지. [[feedback_db_dsc_parity]] [[feedback_enrollment_status_consistency]]
