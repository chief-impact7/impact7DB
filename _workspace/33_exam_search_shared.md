# exam 검색어 shared 교체 (잔여 2번 — exam 정본)

shared `@impact7/shared/student-label`의 `studentSearchTerms`(v1.16.0)로 교체. exam은 정본이라 동작 무변화. 커밋·푸시 미실시(오케스트레이터 검토 대기).

## 변경 지점 (3 파일)

1. **`package.json:15`** — `@impact7/shared` `#v1.15.0` → `#v1.16.0` bump.
   - `npm install`로 lock 갱신. (`npm install`만으론 캐시로 인해 미갱신 → `rm -rf node_modules/@impact7/shared` + `npm cache clean --force` + `npm install @impact7/shared` 필요)
   - `package-lock.json` resolved: `…#9df285a7`(구) → `…#1ab502586`(v1.16.0 태그 커밋) 갱신 확인.

2. **`src/shared/types/impact7-shared.d.ts`** — `studentSearchTerms` ambient 타입 1개 추가.
   - 주의: 분석 §3 지정대로 `[key: string]: unknown` 인덱스 시그니처를 쓰면 callsite `Student & {id}`가 "Index signature missing"으로 TS2345 거부됨.
   - 해결: 인덱스 시그니처 대신 실제 읽는 필드(`level`/`grade`/`school_elementary`/`school_middle`/`school_high`)만 optional로 선언 → 구체 `Student` 타입도 구조적 할당 통과.

3. **`src/shared/lib/student-display.ts`** — 로컬 `schoolSearchTerms` 본문(약 36줄)을 shared 재노출 1줄로 교체.
   - `export { studentSearchTerms as schoolSearchTerms } from "@impact7/shared/student-label";` (callsite 이름 유지 → `students/page.tsx:18,292` 무수정).
   - 미사용이 된 `normalizeRealLevelGrade` import와 `LEVEL_SHORT` const 제거.
   - 다른 export(`formatSchoolShort`/`canonicalSchoolName`/`schoolMatchKey`/`isSameSchoolName`)는 유지. `studentFullLabel` import는 `formatSchoolShort`에서 계속 사용.

## 교체 방식
로컬 함수 삭제 + shared `studentSearchTerms`를 기존 이름 `schoolSearchTerms`로 alias 재노출. callsite(`students/page.tsx:292`의 spread) 무수정.

## 검증 결과
- `npx tsc --noEmit`: 통과(에러 0). (인덱스 시그니처 타입 조정 후)
- `npm run build`: 성공(전 라우트 빌드 완료).
- 설치 모듈 본문이 분석 §2 정본과 동일 확인.
- 표본 출력(shared 직접 실행):
  - `신목 중2` → `["신목","신목중","신목중2"]` ✓ (지정 표본 일치)
  - `진명여자고등학교 고1` → `["진명여","진명여고","진명여고1"]` ✓
  - `학교없음 중2` → `["중2"]` (분석 §1 exam 행과 일치, 동작 무변화)

## 제약 준수
- 커밋·푸시·배포 미실시. shared repo 미수정(v1.16.0 이미 배포됨).
