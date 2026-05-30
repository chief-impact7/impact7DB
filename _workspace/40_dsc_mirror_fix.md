# 40. DSC 미러 잔여 버그 수정 — 전역 전환(구 school 미러 제거) 후속

수정일 2026-05-30. 대상: impact7newDSC. 커밋·푸시·배포 없음(검토 대기).

## C1 (긴급) — diagnostic.js `_upsertStudentFromTemp` client write permission-denied 해소

- 파일: `impact7newDSC/diagnostic.js`
- import 추가: `import { SCHOOL_FIELD } from '@impact7/shared/student-label';` (v1.16.0 의존 기보유)
- `baseFields`에서 `school: data.school || ''` 키 제거.
- 학부별 필드로 저장:
  ```js
  const _sf = SCHOOL_FIELD[data.level];
  if (_sf && data.school) baseFields[_sf] = data.school;
  ```
- `baseFields`는 기존merge 경로(`auditSet(ref, baseFields, {merge:true})`)·신규생성 경로(`newDoc = {...baseFields, status, enrollments, first_registered}`) **양쪽이 공유** → 한 곳 수정으로 둘 다 적용. 로컬 캐시 `Object.assign(cached, baseFields)`·`push({...newDoc})`도 `school_*` 자동 반영.
- `temp-att-level` select 옵션값은 `초등/중등/고등`(index.html L557-559 확인) = `SCHOOL_FIELD` 키와 정확히 일치 → 매핑 누락 없음. `saveTempAttendance`가 level 필수 검증.

**rules 통과 논리 확인:** 수정 후 write 필드 = `name, level, grade, student_phone, parent_phone_1, [branch], [school_elementary|middle|high], (신규) status, enrollments, first_registered`. 전부 students `hasOnly(allowed)` 화이트리스트에 존재(37번 항목3: `school_*` 있음, bare `school` 없음). bare `school` 키 부재 → create/update 모두 allowed 통과. 회귀 해소.

## M (표시 저하) — students `s.school` read 잔여를 currentSchool/schoolSearchTerms로 이전

- `daily-ops.js` 검색 필터 4곳(L1586·L1674·L1789·L1887): `s.school?.toLowerCase().includes(q)` → `schoolSearchTerms(s).some(t => t.toLowerCase().includes(q))`. import `schoolSearchTerms`(school-normalizer.js, shared studentSearchTerms 재노출) 추가 → class-student-search/role-memo/leave-request와 검색 정규화 통일.
- `export-report.js` L180: `s.school || ''` → `currentSchool(s)`. import 추가.
- `past-history.js` L478: `student.school || '—'` → `currentSchool(student) || '—'`. import 추가.
- 제외 확인: 나머지 `.school` 히트는 `ta.school`(temp_attendance)·`c.school`(contacts) 자체 도메인 — 미러 아님.

**잔여 미러 read 0 확인:** `grep "\.school\b" daily-ops.js export-report.js past-history.js diagnostic.js | grep -v temp/ta/c/contact` → 0건.

## QA1 (DailyLogBoard `getBranch`) — 판정: **선재(pre-existing), 이번 수정 범위 분리. 임의 수정 안 함.**

- `getBranch`(L43-50, `enrollments[0].class_number` 첫자리)는 파일 생성 커밋 `e6037bd "Add DSC logbook daily view"`(2026-05-16)에서 **원형 그대로** 도입. `git log -L 43,49`로 확인.
- 전역 전환 커밋(8a8cad6·cfeb812·b431c80·dcb16bd, 2026-05-30)은 `e6037bd`의 2주 후이며, `buildNaesinKey` 내부 `school`→`currentSchool`(L61)만 교체하고 `getBranch`의 브랜치 로직은 **미접촉**. `e6037bd`는 `dcb16bd`의 ancestor(merge-base 확인).
- 결론: 정본 `branchFromStudent`(정규/자유학기 enrollment 기준)와의 분기는 **이번 전역 전환 회귀가 아님**. csKey 미스매치 위험은 `enrollments[0]`가 비정규(내신/특강)이고 그 class_number 첫자리가 정규반과 다를 때만 발생하는 **잠복 선재 이슈**. 즉시 위험·이번 변경 유발 아님 → 임의 수정하지 않고 별건으로 기록.
- 권장(별건): DailyLogBoard가 `student-helpers.js`의 `resolveNaesinCsKey`/`deriveNaesinCode`/`branchFromStudent`를 직접 import해 자체 `getBranch`/`buildNaesinKey`/`resolveNaesinKey`를 단일 정본화. 오케스트레이터 조율 후 별도 작업.

## 검증 결과
- `npm run build`: 성공(748 modules, dist 생성). 청크 크기 경고만(기존).
- `npm test`: 19 pass / 0 fail.
- rules 논리 통과(상기 C1).
- students 미러 read 0(grep).

## 변경 파일
- `impact7newDSC/diagnostic.js` (C1)
- `impact7newDSC/daily-ops.js` (M 검색 4곳 + import)
- `impact7newDSC/export-report.js` (M + import)
- `impact7newDSC/past-history.js` (M + import)
