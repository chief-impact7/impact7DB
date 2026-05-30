# 48 — DB 측 진단평가 버그 수정 (버그2 + shared bump)

## 1. shared bump → v1.18.0
- `package.json`: `@impact7/shared` `#v1.17.0` → `#v1.18.0`
- GitHub git-tarball 캐시가 1.17.0을 재서빙 → `node_modules/@impact7/shared` 삭제 + 일반 `npm install`로는 갱신 실패(version 1.17.0 유지, school 폴백 0건).
- 해결: `npm install @impact7/shared --force` 로 캐시 우회 재설치.
- 검증: `node_modules/@impact7/shared/package.json` version **1.18.0**, `grep -c "student?.school" student-label.js` = **2** (≥1, school 폴백 반영 확인).

## 2. 버그2 — 상담생 검색 사각지대 (app.js)
- 위치: `applyFilterAndRender` 기본 뷰 필터, `if (!hasNonSemesterFilter())` 분기 내 상담/종강 cutoff 비교 (app.js ~1173–1175).
- 변경 전: `updated_at`만 ISO slice 후 cutoff 비교, 없으면 `false`.
- 변경 후: `updated_at` 없으면 `first_registered` 폴백.
```
const ts = (s.updated_at?.toDate?.()?.toISOString?.()?.slice(0, 10)) || s.first_registered || '';
return ts ? ts >= cutoff : false;
```
- 다른 필터 로직·shared repo 무변경.

## 3. 검증
- Vite 빌드 성공 (vite v7.3.2, 36 modules, dist/assets/index-DLPYVUR6.js 527.84 kB).
- 조효빈_1046445057 (status=상담, updated_at 없음, first_registered=2026-05-28):
  - `ACTIVE_STUDENT_STATUSES.has('상담')` → false → cutoff 분기 진입
  - 퇴원 아님 → 폴백 라인: updated_at undefined → `first_registered`='2026-05-28' 사용
  - 현재 학기 cutoff ≤ 2026-05-28 이면 `'2026-05-28' >= cutoff` → **true(목록/검색 포함)**.
  - 수정 전: updatedStr undefined → 무조건 false → **누락**. → 사각지대 해소 확인.
- 정상 학생 무영향: updated_at 있으면 기존과 동일 경로(`||` 단락), 재원/휴원은 폴백 라인 도달 전 early return.

## 제약 준수
- 커밋·푸시·배포 안 함 (검토 후 조율). shared repo·다른 필터 로직 무변경.
