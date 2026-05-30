# exam @impact7/shared v1.18.0 bump 검증

## bump 확인
- `package.json`: `#v1.16.0` → `#v1.18.0` 변경
- `package-lock.json`: resolved 커밋 해시 `1ab502586...` → `29dff6b81...` (v1.18.0 태그)
- 설치 버전: `node_modules/@impact7/shared/package.json` version `1.18.0` 확인
- lock 직접 패치 필요 이유: npm이 캐시에서 v1.15.0 해시를 계속 사용. `git ls-remote`로 v1.18.0 해시를 직접 조회해 수정.

## v1.18.0 폴백 확인
`grep -c "student?.school" node_modules/@impact7/shared/student-label.js` → **2** (≥1 조건 충족)

## tsc / 빌드
- `npx tsc --noEmit`: 에러 없음 (출력 없음)
- `npm run build`: 전 라우트 빌드 성공 (static + dynamic 포함)

## 라벨 표본 — 서울염경중학교
| 입력 | studentFullLabel | searchTerms |
|------|-----------------|-------------|
| school_middle: 서울염경중학교, level: 중등, grade: 1 | **염경중1** | ['염경', '염경중', '염경중1'] |
| school 폴백만(school_middle 없음) | **염경중1** | 동일 |

- 지역명 풀네임(`서울`) 제거 정상 동작
- school 폴백(school_middle 없는 경우) 동일 결과

## exam school_* 회귀 확인
`student.ts` 에 `school_elementary/middle/high` 타입 정의 있음 → v1.18.0 학부별 필드 우선 경로 정상 사용. 폴백 경로(school 단일 필드)는 이 앱에서 해당 없음 — 회귀 없음.

## 변경 파일
- `/Users/jongsooyi/projects/impact7exam/package.json` (버전 bump)
- `/Users/jongsooyi/projects/impact7exam/package-lock.json` (resolved 해시 갱신)
