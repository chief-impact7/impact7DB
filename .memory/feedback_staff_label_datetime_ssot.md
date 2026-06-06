# 담당자 표시·KST 12시간제 SSoT (2026-06-07)

담당자/작성자 표시와 날짜·시간 표시를 `@impact7/shared` 단일 소스로 통일했다.

## 새 shared 모듈 (v1.26.0)
- `@impact7/shared/staff-label` → `staffLabel(emailOrId)`
  - `@` 있으면 앞부분만, 없으면 원본 통과(**idempotent**), trim 적용, 빈값/비문자열 → `''`.
  - 담당자·작성자 **표시 및 저장값** 모두 이걸로 통일. 더 이상 `email.split('@')[0]` 직접 사용 금지.
  - `history-classifier`의 `shortAuthor`(작성자 fallback = `'system'`)와는 fallback 정책이 달라 별도 유지.
- `@impact7/shared/datetime` → `formatTimeKST` / `formatDateTimeKST(v,{withYear})` / `formatDateKST`
  - **타임존 항상 Asia/Seoul, 시간 항상 12시간제(오전/오후)**. 입력 Date/Firestore Timestamp/epoch/ISO 허용, 잘못된 값 → `''`.
  - 직접 `toLocaleString` + `hour:'2-digit'`(24시간제) 쓰지 말고 이걸로.

## 적용 범위 (split('@') 전 앱 0건 달성)
- DB: app.js·past-history.js / DSC: 14개 파일(표시+저장) + 시간 6곳 12시간제 / HR: auth.ts + format.ts(shared 의존성 신규 도입) / exam: 4개 지점, 로컬 userPrefix·emailToId 헬퍼 제거.

## Why
shared에 `shortAuthor`가 있었지만 아무도 import 안 하고 각 앱이 `split('@')[0]`을 중복 구현 → drift. 타임존은 적용돼 있었으나 12시간제 규칙은 코드에 없었음(암묵적 24시간제).

## 배포 절차 (GitHub 태그 방식)
shared는 `github:chief-impact7/impact7-shared#vX.Y.Z`로 연결. 변경 시: ① shared 커밋+`git tag v1.26.0`+push → ② 각 앱 `npm install` → ③ 각 앱 커밋·push. **태그 push를 가장 먼저** (안 하면 다른 환경 `npm ci` 깨짐). package.json 4앱 모두 `#v1.26.0`으로 정렬해 둠.

관련: [[feedback_history_classifier_sync]]
