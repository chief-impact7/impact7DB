# Claude Code - impact7DB 프로젝트 설정

## 공유 Firebase 규칙 — Storage (SSoT: 이 프로젝트)

이 프로젝트가 **Firebase Storage 규칙 단일 진실 원천(SSoT)**.
5개 앱(DB/newDSC/HR/exam/qbank) 동일 Storage 버킷 공유. 규칙 배포는 반드시 여기서만.

### Storage 규칙 배포 절차
1. `storage.rules` 수정 (앱 추가 시 새 경로 블록 append)
2. `firebase deploy --only storage --project impact7db`
3. 변경된 `storage.rules` 모든 프로젝트에 복사 (동기화)

### 절대 금지
- `firebase deploy --only storage` (또는 `firebase deploy`) **impact7exam, impact7HR 등 다른 프로젝트에서 실행 금지**
- 그 프로젝트 `firebase.json`에 storage 배포 설정 없음 — 실수 배포 불가

### 현재 등록된 Storage 경로
| 경로 | 앱 | 설명 |
|------|----|------|
| `exam-papers/` | impact7exam | 시험지·답안지 이미지 |
| `scans/` | impact7exam | OCR 스캔·외부 성적표 이미지 |
| `staff/` | impact7HR | 직원 문서 |
| `contracts/` | impact7HR | 계약서 PDF |
| `expenses/` | impact7HR | 경비 영수증 |
| `signatures/` | impact7HR | 서명 이미지 |

## 코드 품질 관리
- 소스 코드(`.js`·`.ts`·`.tsx`·`.py`·`.svelte` 등) 추가·수정·삭제 커밋은 commit 전 `/simplify` → `/code-review` 순차 실행, 결과 반영.
- 제외: 문서(`*.md`)·lock 파일·JSON 데이터·단순 설정만 바뀐 커밋.
- skip: 사용자가 "이번엔 commit만"·"급해" 등 명시할 때만.
- 로컬 git hook이 품질 확인 마커 없는 staged source/security diff 커밋 차단. simplify/review/fix 후 repo 루트에서 `node /Users/jongsooyi/projects/impact7DB/.agents/hooks/impact7-precommit-quality-guard.mjs --mark`로 현재 staged diff 표시.
- 푸시하면 Actions 자동 배포 — 푸시 전 점검이 마지막 안전장치.

## impact7 검색·생성 우선순위 — shared-first

impact7 에코시스템에서 기능·함수·상태값·도메인 로직·코드 위치 검색·설명 시 현재 앱 로컬 구현보다 `/Users/jongsooyi/projects/impact7-shared`의 `@impact7/shared` 계약 표면 먼저 확인.

검색 순서:
1. `/Users/jongsooyi/projects/impact7-shared/package.json` export map 확인
2. 관련 shared 모듈 검색
3. 현재 앱 로컬 구현 검색
4. shared 계약과 로컬 구현 다르면 drift로 보고, 원인 확인

**생성 규칙:** 새 코드·UI/UX도 shared 모듈 먼저 참고해 재사용. 로컬 재구현 금지. 필요한 순수 함수가 shared에 없으면 로컬 구현 대신 shared 추가 먼저 제안.

현재 shared 기준 export (정본: impact7-shared/AGENTS.md "모듈 목록 및 공개 API"):
- `@impact7/shared/history` → `history-classifier.js`
- `@impact7/shared/enrollment-status` → `enrollment-status.js`
- `@impact7/shared/enrollment-derivation` → `enrollment-derivation.js`
- `@impact7/shared/class-move` → `class-move.js`
- `@impact7/shared/promote-enroll` → `promote-enroll.js`
- `@impact7/shared/student-number` → `student-number.js`
- `@impact7/shared/student-label` → `student-label.js`
- `@impact7/shared/staff-label` → `staff-label.js`
- `@impact7/shared/datetime` → `datetime.js`
- `@impact7/shared/ime-input` → `ime-input.js`
- `@impact7/shared/html-escape` → `html-escape.js`
- `@impact7/shared/phone` → `phone.js`
- `@impact7/shared/branch` → `branch.js`

특히 학생 상태, 재원 여부, 수업이력, 내신/자유학기 파생, 학생 표시/검색/번호, 반 이동, 자동 승격, 학생 매칭, KST 날짜·시간 표시, IME 입력 어트리뷰트, HTML escape, 전화번호 표기, 단지 파생 작업은 shared 계약 기준 비교.

### 학교+학부+학년 표시 계약

- 학생 마스터 객체 표시는 `studentFullLabel(student)`.
- 학교·학부·학년 개별 값 표시는 `schoolLevelGradeLabel({ school, level, grade })`.
- UI, 문자, 메일, 파일명에서 `school + level + grade` 직접 문자열 조합 금지.
- 저장값·필터·학교 매칭은 원본 필드 유지, 축약형은 표시 시점에만 생성.

자동 주입 hook 정본은 `.agents/hooks/impact7-shared-first-search.mjs`. Codex·Claude Code 등 도구별 hook 설정은 이 파일 호출만 — 도구별 설정 폴더(`~/.codex/hooks`, `~/.claude/settings.json` 등)에 로직 사본 금지.

## app.js 모듈 분리 규칙 (2026-04-12 결정)

impact7DB는 에코시스템 마스터 데이터 허브 — app.js(현재 ~6000줄) 점진 분리.

**규칙 1 — 새 기능은 별도 모듈로 작성한다**
- `app.js`에 코드 추가 금지
- 별도 `.js` 파일 생성, 공유 상태는 `store.js`에서 import
- `window.*` 함수 등록은 모듈 파일 안에서

**규칙 3 — 공유 상태는 store.js를 통한다**
- 새 모듈에서 공유 상태(allStudents, activeFilters, currentStudentId 등) 필요하면 `store.js`에서 import
- 상태 변경은 `update()` 사용, 배열/객체 직접 mutate 금지
- 기존 app.js 코드 분리 시 해당 블록 상태 접근도 store.js로 전환

**규칙 2 — 기존 코드는 수정할 때 분리한다**
- 기존 블록 수정 시 그 블록을 별도 파일로 분리
- 안 건드리는 코드는 그대로 (리스크 없는 점진 축소)

**분리 우선순위** (독립성 높은 순):
1. 패널 리사이저 (~35줄) — 공유 상태 참조 0
2. 일별 통계 (~230줄) — currentUserRole만 참조
3. 내신 시간표 (~380줄) — allStudents, activeFilters 읽기
4. 문법 특강 (~550줄) — allStudents 읽기/쓰기
5. 휴퇴원요청서, Google Sheets, 일괄처리 — 공유 상태 깊이 의존

**주의:** allStudents 배열 직접 mutate 블록은 `store.js`의 `update()`로 전환해야 분리 가능. 상세 분석: `.memory/feedback_module_separation.md`.

## 공유 백엔드 — Cloud Functions `shared` codebase (SSoT: 이 프로젝트)

DB/DSC/HR/exam 공유 **횡단 백엔드 서비스**(카카오 알림톡·친구톡, 문자, 결제 PG, 출결연동 알림)는 `functions-shared/` codebase로 여기서만 관리.

### codebase 현황
| codebase | 소스 | 용도 |
|----------|------|------|
| `leave-request` | `functions/` | 휴·퇴원 요청 자동화, 내신 기간 동기화, 클래스 정리 |
| `shared` | `functions-shared/` | **배포됨**: AI 게이트웨이(`llmGenerate`·학생리포트), solapi 메시징(알림톡/SMS·프로모·080), 출결 체크인(`tabletCheckin`/`staffCheckin`), HR 업로드·서명. 골격만: `sendKakao`/`paymentHook`(결제, 하반기) |

### 배포 절차
```bash
# shared codebase만 배포 (leave-request 함수 건드리지 않음)
firebase deploy --only functions:shared --project impact7db
```
- `firebase deploy --only functions` 는 **두 codebase 모두 배포** — 의도 없으면 금지
- `firebase deploy` 는 **전체(hosting 포함) 배포** — 마찬가지 주의

### codebase 클로버링 방지 규칙
- 새 공유 함수는 반드시 `functions-shared/index.js`에만 추가
- `functions/index.js`(leave-request)에 카카오·결제 코드 추가 금지
- HR `functions/` 는 codebase 미지정(`default`) — impact7DB에서 `firebase deploy --only functions` 실행 시 HR default 함수와 충돌 없음 (codebase 다름), 그래도 주의

### 조직 정책 — public 함수 (2026-05-22 완화)
- gw.impact7.kr 조직 `iam.allowedPolicyMemberDomains`가 `allUsers` 차단 — Callable/HTTP 함수 public invoker 설정 불가였음.
- **impact7db 프로젝트만** 정책 `allValues: ALLOW` override 완료. public Cloud Functions/Run 가능.
- 향후 `sendKakao`(Callable)·`paymentHook`(결제 웹훅)도 이 완화 전제로 동작. 함수는 `request.auth`/서명검증으로 보호.

### Secret Manager 위치 (향후 키 발급 시)
- 경로: `projects/impact7db/secrets/<name>`
- 카카오 API 키: `kakao-api-key`
- PG 시크릿: `pg-secret-key`
- 함수 참조: `defineSecret('kakao-api-key')` (firebase-functions/params)

### 향후 추가 함수 설계
| 함수명 | 트리거 | 설명 |
|--------|--------|------|
| `paymentHook` | HTTP 웹훅 | PG 결제 결과 수신·서명검증·멱등처리 (하반기) |

**현재 배포 상태 (2026-07-11):** functions-shared는 풀 프로덕션 백엔드 — AI(`llmGenerate`·학생리포트), solapi 메시징(알림톡/SMS·프로모·080 수신거부), 출결(`tabletCheckin`/`staffCheckin`), HR 업로드·서명 **배포됨**. 알림톡 발송은 별도 `sendKakao` 없이 queueWorker→solapiProvider 경로로 동작. 골격만 남은 것은 `sendKakao`/`paymentHook` 2개(결제 하반기). exam은 자체 서버에서 Vertex 직접(`@google-cloud/vertexai`). 상세: `.memory/project_shared_backend_foundation.md`.

## 에코시스템 차트 표준

**표준 라이브러리:** `echarts` + `echarts-for-react`

| 앱 | 현황 |
|----|------|
| impact7newDSC | ✅ echarts + echarts-for-react |
| impact7exam | ✅ echarts + echarts-for-react (2026-06-08 recharts에서 전환) |
| impact7DB / impact7HR | 차트 없음 — 추가 시 동일 표준 적용 |

- import: `import ReactECharts from 'echarts-for-react'`
- option 객체를 `option` prop으로 전달, `notMerge={true}` 기본
- 애니메이션 불필요 시 option에 `animation: false` (PDF 렌더 등)
- recharts·chart.js 등 다른 차트 라이브러리 추가 금지

## codegraph 탐색 원칙

코드 탐색 시 Read·grep 전에 **`codegraph_explore` 먼저** 실행.
`.memory/reference_codegraph_guide.md`에 도메인별 핵심 쿼리 정리됨.
@impact7/shared 작업은 shared-first 원칙 준수 (위 "impact7 검색 우선순위" 참조).

## 메모리 (계정 공유)

1인 개발. 여러 Claude 계정 번갈아 사용, 동일 사용자.
작업 기록/피드백은 **이 프로젝트 폴더 안** `.memory/`에 저장.
계정별 `~/.claude-*/projects/*/memory/` 저장 금지.

- 새 대화 시작 시 `.memory/MEMORY.md` 먼저 읽기
- 메모리 저장 시 `.memory/`에 파일 생성, `.memory/MEMORY.md` 인덱스 업데이트

## 하네스: impact7 에코시스템 통합 운영

**목표:** DB/DSC/HR/exam/tablet/consultation/newtest/dashboard 크로스앱 작업 안전 조율 (모두 공유 Firebase 프로젝트 `impact7db`). 전담 개발자 에이전트 보유 앱: DB/DSC/HR/exam/tablet + functions-shared 백엔드.

**트리거:** 크로스앱 변경, 공유 컬렉션 수정, 다중 앱 기능 개발, 태블릿/키오스크/출결·외출 체크인 요청 시 `impact7-orchestrator` 스킬 사용. 단일 앱 소규모 변경·단순 질문은 직접 응답.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-12 | 초기 구성 | 전체 | 에코시스템 통합 운영 하네스 구축 |
| 2026-04-12 | cross-app-analysis ↔ impact-analyst 중복 해소 | agents/impact-analyst.md, skills/cross-app-analysis | 위험도 판정표·분석절차 에이전트로 통합, 스킬은 얇은 트리거로 축소 |
| 2026-04-12 | app.js 모듈 분리 규칙 추가 | AGENTS.md, agents/db-developer.md, skills/impact7-orchestrator | 새 기능은 별도 모듈, 기존 코드는 수정 시 분리 |
| 2026-05-22 | shared codebase 슬롯 예약 | firebase.json, functions-shared/, AGENTS.md | 카카오·결제·출결 공유 백엔드 기반 구성 (실 구현은 하반기) |
| 2026-05-26 | 에코시스템 범위 4→6개 앱 확장 + 형제 앱에 크로스앱 조율 cross-ref 추가 | AGENTS.md(DB 목표), impact7newDSC·HR·exam·newtest AGENTS.md | consultation·newtest 편입. 풀 블록 대신 한 줄 cross-ref로 형제 앱에 "크로스앱은 DB에서 조율" 인지만 노출 (orchestrator 스킬은 DB에만 존재) |
| 2026-05-27 | 에코시스템 범위 6→7개 앱 확장 (dashboard 편입) + DashBoard에 cross-ref 추가 | AGENTS.md(DB 목표), DashBoard AGENTS.md | DashBoard(academy-dashboard, React19+Vite8)가 impact7db Firestore 읽음 확인. consultation·newtest는 cross-ref 기보유. orchestrator 전담 개발자 에이전트는 여전히 DB/DSC/HR/exam 4개뿐 — consultation/newtest/dashboard는 자체 하네스 구현, DB는 조율만. firestore.rules 동기화 대상은 rules 보유 DB/DSC/HR/exam 4개 그대로 |
| 2026-06-09 | store.js 동기화 취약점 4개 보완(leaveRequests 7곳·currentFilteredStudents·KST날짜·naesinHelpers drift) + 에이전트 하네스 정합성 업데이트 | app.js, promo-extractor.js, functions/src/naesinHelpers.js, agents/db-developer.md, agents/dsc-developer.md, agents/exam-developer.md, agents/impact-analyst.md | store.state stale 참조 alias drift 버그 수정; 에이전트 파일 차트 라이브러리(Recharts→echarts)·store.js 사용법·codegraph 탐색 원칙·consultation 컬렉션 맵 갱신 |
| 2026-06-13 | functions-developer 에이전트 + student-report-ai 스킬 신설, 오케스트레이터 연결 | agents/functions-developer.md, skills/student-report-ai, skills/impact7-orchestrator, skills/firestore-rules-sync | functions-shared(Cloud Functions 백엔드: Gemini callable·secret·무중단 배포) 전담 부재 갭 해소(db-developer는 app.js 프론트). 학생 AI 리포트 도메인 지식(데이터모델 함정·통합 핸들러·Chat DWD 연동) student-report/PLAN.md에서 스킬로 이관. rules-sync에 CRLF 보존(cp) 교훈 추가 |
| 2026-06-18 | tablet 앱(출결 키오스크) 하네스 편입 — tablet-developer 신설, impact-analyst/qa-validator 확장, 오케스트레이터 연결 | agents/tablet-developer.md, agents/impact-analyst.md, agents/qa-validator.md, skills/impact7-orchestrator | 신규 태블릿 출결/외출 키오스크 앱(/Users/jongsooyi/projects/tablet, Vanilla JS+Vite) 전담 부재 갭 해소. 태블릿은 Firestore 직접 접근 없이 tabletCheckin callable 경유 — 백엔드(functions-developer)·DSC 캐시(dsc-developer)와 크로스앱. 신규 컬렉션 attendance_events/kiosk_devices 맵 추가, callable shape 경계면 qa-validator에 추가 |

## 프론트엔드 수렴 정책 (impact7 에코시스템)

분열된 프레임워크(바닐라 DSC·DB / Svelte HR / Next exam) 강제 통합 않고 **점진 수렴**.

- **신규 화면·앱은 React(Next)**. 기존 바닐라·Svelte는 강제 마이그레이션 없이 수명 다할 때 React로 교체.
- **공유 UI는 `@impact7/ui`** (`github:chief-impact7/impact7-ui`). React 앱은 컴포넌트 직접 import, 바닐라/Svelte 앱은 `@impact7/ui/mount` 어댑터로 부분 마운트(islands) — **반드시 `unmount`로 정리, 한 앱 *내부* 프레임워크 혼용 남발 금지**(ROI 높은 영역만).
- **공유 레이어 재사용**: 디자인=`design-tokens.json` SSoT, 로직=`@impact7/shared`, 접근성=`a11y.css`/`a11y-dom.js`. 컴포넌트(렌더링)만 프레임워크 종속 — 그 위 레이어는 항상 공유.
- 토큰/공유DOM drift는 `impact7DB/.agents/hooks/check-design-tokens.mjs`·`check-shared-dom.mjs`(pre-push)가 차단.