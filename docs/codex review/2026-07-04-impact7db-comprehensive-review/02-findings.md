# Findings

## P0/P1 보안·운영

### F-01. runtime dependency audit가 세 패키지에서 실패한다

심각도: P1

근거:
- root `npm audit --omit=dev`: `protobufjs` critical, `@grpc/grpc-js` high, `@protobufjs/utf8` moderate.
- `functions` `npm audit --omit=dev`: 17 vulnerabilities, high 4건 포함.
- `functions-shared` `npm audit --omit=dev`: 11 vulnerabilities, high 2건 포함.
- 관련 dependency 선언: `package.json:29-36`, `functions/package.json:16-24`, `functions-shared/package.json:12-21`.

위험:
- Firestore/Admin/Functions 계열 transitive dependency가 포함되어 Cloud Functions runtime과 로컬 운영 스크립트 양쪽에 영향을 준다.
- `npm audit fix --force`는 `firebase-admin@14.1.0` breaking change를 제안하므로 무작정 적용하면 함수 배포/테스트가 깨질 수 있다.

권장:
- root/functions/functions-shared를 각각 별도 브랜치에서 `npm audit fix` 가능한 범위부터 적용한다.
- `firebase-admin` major/breaking 후보는 Functions emulator + deploy dry path로 검증한 뒤 올린다.

### F-02. callable 대부분이 App Check 미적용 상태다

심각도: P1

근거:
- `functions-shared/index.js:55-60` 주석은 App Check 카나리를 언급하지만 `llmGenerate`, `generateStudentReportAi` 모두 `enforceAppCheck: false`.
- `functions-shared/index.js:80-82`, `89-111`, `123-177`, `193-202` 등 비용·파일·메시지·AI callable 대부분이 `enforceAppCheck: false`.
- `authGuards.js:11-17`은 직원 도메인 auth를 검증하지만 App Check abuse 방어와는 별개다.

위험:
- 인증된 내부 계정 탈취, 자동화 abuse, 메시지/AI 비용 증폭에 대한 2차 방어선이 약하다.
- public token callable은 의도적으로 비로그인 경계가 필요하지만, 직원 전용 callable까지 같은 형태로 남아 있다.

권장:
- 직원 전용 callable부터 App Check enforce 단계 적용: read-only/저비용 → AI/메시지/파일 순서.
- 공개 토큰 callable은 별도 목록으로 유지하고 rate limit, 토큰 소진, 만료 테스트를 강화한다.

### F-03. 배포 후 모든 Cloud Run 서비스에 public invoker를 재부여한다

심각도: P1

근거:
- `.github/workflows/deploy-functions.yml:74-87`에서 `gcloud run services list` 전체를 순회해 `allUsers roles/run.invoker`를 부여한다.
- 현재 의도는 onCall public invoker 복구지만, allowlist 없이 region 전체 서비스에 적용된다.

위험:
- 미래에 내부 전용 HTTP/Run 서비스가 같은 region/project에 생기면 배포 워크플로가 자동으로 공개 invoker를 부여할 수 있다.
- 함수 내부 auth guard가 없는 HTTP 서비스가 추가되면 공개 접근면이 생긴다.

권장:
- callable 서비스명 allowlist 또는 label 기반 필터를 둔다.
- `healthCheck`, `paymentHook` 같은 공개 HTTP와 직원 callable을 분리해 정책을 문서화한다.

## P1 신뢰성

### F-04. `functions` 단독 test script가 CI 계약과 다르다

심각도: P1

근거:
- `functions/package.json:8-10`의 `test`는 단순 `vitest run`.
- 실제 실행 결과 `npm test`는 integration hook timeout 23개 실패.
- 같은 테스트를 `firebase emulators:exec --only firestore --project demo-impact7 "npx vitest run"`로 실행하면 13 files / 97 tests 통과.

위험:
- 로컬/에이전트/신규 개발자가 단독 `npm test` 실패를 제품 회귀로 오판하거나, 반대로 실패를 무시하는 습관이 생긴다.
- CI는 맞게 돌지만 package script와 다르면 handoff 품질이 떨어진다.

권장:
- `functions`에 `test:unit`, `test:integration`, `test:emulator`를 분리한다.
- 기본 `npm test`를 CI와 동일하게 emulator 실행으로 바꾸거나, integration 파일을 기본에서 제외한다.

### F-05. `app.js` 상태 계약이 `store.js` 규칙과 아직 충돌한다

심각도: P1

근거:
- `store.js:61-66`은 직접 mutation 금지를 명시한다.
- `app.js:566-573`, `867-876`, `4258-4259`, `6523` 등에서 `allStudents` 배열을 직접 비우거나 push/대입한다.
- `app.js:1298`은 `currentFilteredStudents`를 로컬 변수로 직접 갱신한다.

위험:
- 새 모듈이 `store.state.allStudents`를 참조할 때, 로컬 `allStudents`와 store snapshot 사이의 타이밍 drift가 생길 수 있다.
- 분리 진행 중인 모듈에서 UI 갱신 누락, 필터/내보내기 불일치가 재발하기 쉽다.

권장:
- 기존 대형 변경은 피하되, 수정하는 기능부터 `storeUpdate({ allStudents: next })`로 새 배열 교체 패턴을 적용한다.
- `currentFilteredStudents`도 store 단일 경로로 옮겨 내보내기/필터/리렌더 기준을 맞춘다.

## P2 신속성·유지보수

### F-06. 대형 단일 프론트엔드가 변경 속도를 제한한다

심각도: P2

근거:
- 파일 크기: `app.js` 312KB, `style.css` 86KB, `index.html` 78KB.
- `npm run build` 결과 메인 JS chunk 632.49KB, Vite chunk warning 발생.
- `index.html`의 `<script src="help-guide.js">`는 `type="module"`이 없어 번들되지 않는다는 경고가 나온다.

위험:
- 기능 하나 수정해도 빌드/리뷰/회귀 범위가 넓고, 충돌 가능성이 높다.
- 초기 로드와 디버깅 신속성이 떨어진다.

권장:
- AGENTS의 모듈 분리 규칙대로 수정 대상 블록부터 파일 분리한다.
- 독립성이 높은 daily stats, Google Sheets, bulk action, leave request UI부터 chunk 분리 후보로 잡는다.

### F-07. root unit test 범위가 프론트 핵심 UX에 비해 좁다

심각도: P2

근거:
- `package.json:11-14`의 root unit은 `class-enrollment-policy.test.js`, `promo-extractor-core.test.js`뿐이고 나머지는 rules 중심이다.
- `app.js` 저장/일괄변경/필터/상태 동기화에 대한 DOM 또는 pure helper 테스트가 거의 없다.

위험:
- Firestore rules는 강하지만, 프론트에서 잘못된 요청을 만들거나 로컬 상태만 틀어지는 회귀는 테스트가 잡기 어렵다.

권장:
- 대형 DOM 테스트보다 먼저 pure helper 추출 + node test를 추가한다.
- bulk status/class/day/school 변경의 payload 생성 함수를 분리해 rules와 같은 계약을 검증한다.

### F-08. 운영 스크립트가 root의 로컬 service account를 자동 사용한다

심각도: P2

근거:
- `service-account.json`은 git 추적 대상이 아니고 `.gitignore`에 포함되어 있다.
- 여러 운영 스크립트가 `service-account.json`을 우선 읽고 운영 `impact7db`에 접근한다.

위험:
- 1인 운영에는 빠르지만, 잘못된 디렉터리/오래된 키/실행 플래그 실수로 운영 Firestore에 직접 쓰는 사고 가능성이 있다.

권장:
- destructive/쓰기 스크립트는 `--execute`/`--apply` 외에 projectId 확인 프롬프트 또는 dry-run diff 요약을 표준화한다.
- 오래된 root 일회성 스크립트는 `_archive`로 격리하거나 README에 위험 등급을 표시한다.

## 방어가 잘 된 항목

- `firestore.rules:80-148` students는 field allowlist, field limit, enrollment/status consistency, delete 차단을 둔다.
- `firestore.rules:1320-1322` message_queue는 client read/write 전면 차단.
- `storage.rules`는 HR 파일 직접 접근을 차단하고, Storage emulator tests 16개가 통과했다.
- `scripts/check-shared-lock-sync.mjs:8-49`는 root/functions/functions-shared shared 버전과 lock drift를 함께 잡는다.
