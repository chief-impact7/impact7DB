# G11 — 릴리스 패키지 (G12 배포 증거·순서·스모크·롤백)

- 상태: 배포 대기 (G12 단일 confirm 후 실행)
- 브랜치: impact7DB `fix/comprehensive-review-2026-06-21` (15+ commits), impact7HR `feat/G10-public-token-callable` (2 commits)
- 운영 반영 0건 — 모든 변경은 feature 브랜치, 로컬 검증만.

## 무엇이 배포되나

| 대상 | 내용 | 배포 수단 |
|------|------|-----------|
| functions:shared (impact7DB) | getHrPublicToken, hrUploadStaffDocument/Contract/SignedContract, hrGetFileUrl(신규) + llmGenerate 인증·rate limit, queueWorker SMS atomic, chatSync clock | CI deploy-functions(validate→deploy) 또는 수동 |
| functions:leave-request (impact7DB) | syncStudentScores NOT_FOUND·retry, naesin trigger 재전파·retry | 동일 CI |
| firestore.rules (impact7DB SSoT) | exam_users/exam_analyses 도메인게이트, enrollment 정합성, 필드한도 48, HR 공개 token read·staff/employee/contract get 제거(G03) | 수동 `firebase deploy --only firestore` |
| storage.rules (impact7DB SSoT) | HR 경로(staff/contracts/expenses/signatures) 직접접근 차단(H-01) | 수동 `firebase deploy --only storage` |
| hosting (app.js 등) | 학생저장 atomic, 일괄 reconcile/부분성공, currentStudentId 미러 등 | deploy.yml → 통합 hosting |
| impact7HR 앱 | 공개페이지 callable 전환(G10) + Storage 클라 callable 전환(H-01) | HR 자체 파이프라인 |

## 배포 순서 (load-bearing — 어기면 HR 파손)

1. **functions 먼저**: `functions:shared` + `functions:leave-request` 배포 → 새 callable 라이브.
   (CI: master 머지 시 validate job 통과 후 자동. 또는 수동 `firebase deploy --only functions:shared,functions:leave-request --project impact7db`.)
2. **HR 앱 배포**: impact7HR `feat/G10-public-token-callable` 머지·배포 → 공개페이지·업로드가 callable 호출.
3. **rules 반영**: `firebase deploy --only firestore,storage --project impact7db`.
   - **반드시 1·2 완료·smoke 후.** 먼저 닫으면 HR 공개 온보딩/서명/업로드가 깨진다.
4. **4-repo rules sync**: `firestore-rules-sync` 스킬로 DB/DSC/HR/exam에 firestore.rules 동기화(+ storage.rules는 DB가 SSoT).
5. **hosting**: app.js 변경은 master push 시 deploy.yml → 통합 hosting 재빌드.
6. **smoke**(아래) → 이상 없으면 **branch protection(G09)** 설정.

## 검증 증거 (로컬)

- functions-shared: vitest 350/350
- functions(leave-request): vitest 94/94 (emulator, 직렬)
- firestore rules: 59/59 (emulator) — exam-users/analyses/enrollment/필드한도/HR lockdown 포함
- storage rules: 16/16 (emulator) — HR 차단·exam 유지·student-records 이미지전용
- vite build: 성공 (메인청크 ~625KB, 비모듈 help-guide 경고는 기존 O-05)
- impact7HR: svelte-check 0 errors, build 성공
- 보안 변경 독립 리뷰: G01·G02·H-04·M-05·G02(security-reviewer) 모두 통과
- 모든 소스 커밋에 품질 가드 마커

## 배포 후 SMOKE 체크리스트

**보안(핵심):**
- [ ] exam 로그인 → exam_users 자기문서 정상, 외부 도메인(@gmail) 접근 거부
- [ ] HR 공개 온보딩 링크 6종(onboarding/employee/shortTerm/contract/salary/employeeContract): 토큰 검증·이름표시·만료/사용됨 메시지
- [ ] HR 계약/급여 서명: 마스킹 표시(주민번호 ******·계좌 끝4) → 서명 → PDF 업로드 성공(HR-13 해소)·write-once
- [ ] HR 직원문서 업로드/다운로드(hrUpload/getFileUrl), 관리자 계약 PDF 발송 3경로
- [ ] llmGenerate: 직원 허용, 외부 도메인 거부
- [ ] 공개 토큰 list/get 직접 시도 거부, staff/employee/contract 직접 get 거부 (rules 반영 후)

**신뢰성/정합성:**
- [ ] 학생 저장(편집/신규/재등록) → students + history_logs 둘 다 기록
- [ ] 일괄 퇴원: 정규반 보유 학생 포함해도 성공(enrollment 정리), 부분실패 시 "X/Y명" 표시
- [ ] 성적/내신 trigger 정상, 삭제 멱등
- [ ] 문법특강 일괄 저장

## 롤백

- functions: `firebase functions:rollback` 또는 직전 SHA 재배포.
- rules: 직전 firestore.rules/storage.rules로 `firebase deploy --only firestore,storage` (git revert 후).
- hosting: 통합 hosting 직전 빌드로.
- 가장 위험한 건 rules 잠금 — HR 깨지면 storage.rules HR 블록을 직전(isAuthorized)으로 즉시 롤백.

## 남은 follow-up (G12 후, 비차단)

- hrDeleteFile callable: 현재 HR 문서 삭제가 Firestore만 지우고 Storage 파일 고아화(경미).
- hrUploadEntityDocument callable: settings의 entities/ 사업자문서 업로드(현재도 default-deny라 미동작).
- G08: 필드한도는 O-04로 48 상향 완료(운영 데이터 측정 불요).
- G09: master branch protection — 위 smoke 후 gh로 설정.
- L-1: HR 토큰 ID Math.random→CSPRNG, L-3/N-05: 비용 callable App Check.
