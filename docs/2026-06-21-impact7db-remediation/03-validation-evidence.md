# 검증 증거 (재검증·재실행본)

Codex 1차 검증을 그대로 신뢰하지 않고, 라인 단위 대조 + 순수 테스트 실제 실행 + `npm audit` 재실행으로 확인했다.

## rules 직접 정독 결과 (P0 핵심)

| 항목 | 확인 위치 | 결론 |
|------|-----------|------|
| exam_users 자가 owner | `firestore.rules:198-203` | write 자기문서 전체 허용, read/write `isLoggedIn()`(도메인 미검증) |
| 공개 토큰 read 6곳 | `:784,801,818,864,995,1009` | 모두 `allow read: if true` |
| 직원/계약 공개 get 4곳 | `:889,897,1030,1036` | 모두 `allow get: if true` |
| exam_analyses 외부 read | `:1165-1167` | `request.auth != null`(도메인 미검증) |
| 학생 필드 한도 | 허용 `:78-96`(48개) vs `:112,118`(36) | 36 초과 정상 문서 거부 |
| Storage HR 경로 | `storage.rules:12-38` | 전부 `isAuthorized()`(도메인뿐), 크기/MIME 무제한 |

## 순수 단위 테스트 실제 실행 (emulator·네트워크 불필요)

```
# functions-shared
npx vitest run test/student-label-sync.test.js test/chatSyncHandler.test.js
→ 3 failed | 8 passed (11)
  × student-label-sync: "라벨이 바뀌면 update 반환"
    expected { school_level_grade:'봉영여중1' } to equal { school:'봉영여자중학교', … }
  × student-label-sync: "school 미러 + label 둘 다 갱신"
    expected { school_level_grade:'봉영여중1' } to equal { school:'봉영여중', … }
  × chatSyncHandler: "advances last_synced_time to the newest fetched message"
    expected '2026-06-17T17:08:11.021Z' to be '2026-06-12T05:00:00Z'

node --test test/attendanceState.test.js
→ FAIL: allowedActions(OUT) actual ['귀원'] expected ['복귀']
        ACTION_TEMPLATE_KEY['복귀'] actual undefined expected 'return'

# root 순수 테스트
tests/class-enrollment-policy.test.js → 4/4 pass
tests/promo-extractor-core.test.js   → 32/32 pass
```

해석:
- student-label-sync·attendanceState 실패는 **테스트가 폐기된 구 계약(school 미러 / `복귀`)을 기대** — 구현이 옳고 테스트가 stale. fixture를 현 계약(`school_*` SSoT, `귀원`)으로 갱신해야 함.
- chatSync 실패는 고정 날짜 fixture vs `now()-3일` 커서 충돌 — clock injection 필요.

## emulator 의존 테스트 (현 환경 미기동)

```
root: npm test (tests/firestore.rules.*.test.js)
→ TypeError: fetch failed, ECONNREFUSED 127.0.0.1:8080  (emulator 미기동 — 코드 결함 아님)
```
- `firebase.json`에 emulators 블록·`emulators:exec` 래퍼 없음 → 수동 prereq. [N-10]
- 통합 테스트 3종은 동일 projectId `impact7db-test`·동일 컬렉션 병렬 삭제 구조 확인(`functions/test/*.integration.test.js:10-11,20-21`).

## CI/배포 정적 확인

- `deploy-functions.yml`: 단일 `deploy` job, `needs:`/test/lint/`npm ci` 없음(`:49,57` `npm install`).
- `deploy.yml:14-19`: `curl -s` 단발 dispatch, 실패 미감지·downstream 미추적.
- `firebase.json`: predeploy 훅·emulators 블록 없음.
- lockfile 추적: `git ls-files` → 루트 `package-lock.json`만. functions/functions-shared 미추적(`.gitignore:17` 광역 규칙).
- shared 버전: 루트/functions-shared v1.30.0, functions **v1.28.0**. `update-shared.yml:26-33`은 루트만 bump.

## 의존성 감사 재실행 (`npm audit --omit=dev`)

| 패키지 | Critical | High | Moderate | Low |
|---|---:|---:|---:|---:|
| root | 1 | 1 | 1 | 0 |
| functions | 0 | 4 | 12 | 1 |
| functions-shared | 0 | 2 | 9 | 0 |

Codex 수치와 **정확히 일치**. (dev 포함 시 더 높음: root 1/6/10/2, functions 1/5/34/2, functions-shared 1/3/12/0.) 취약 패키지 존재 증거이며 개별 도달 가능성은 별도 분석 필요.

## 깨진/누락 자산 확인

- `migrate-school-label.js`: disk·git 모두 없음 → `migrate:label` 실행 시 MODULE_NOT_FOUND. [O-01]
- `help-guide.js` vs `public/help-guide.js`: 둘 다 추적, MD5 상이, 양방향 fork. [O-03]

## 테스트 범위 공백

- HR 토큰/직원/계약/`exam_users`/`exam_analyses`/메시지큐/결제/키오스크 rules 자동 검증 없음.
- Storage rules 테스트 0건(5앱 공유 버킷 SSoT인데 무커버).
- post-deploy smoke test·rollback workflow 없음.
- 신규 발견(N-01·N-02 등) 회귀 테스트 부재 → 06-test-writing-guide.md 매트릭스로 보강.
