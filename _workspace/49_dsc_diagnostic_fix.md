# 49 — 진단평가 버그 수정 (DSC 측: 버그4 + shared bump)

날짜: 2026-05-31 / 대상: impact7newDSC / 상태: 구현 완료 (커밋 전, 검토 대기)

## 1. shared bump 확인
- `package.json`: `@impact7/shared` `#v1.17.0` → `#v1.18.0`
- github git 캐시 회피: `node_modules/@impact7/shared` 삭제 + `npm cache clean --force` + **lock의 stale 엔트리(8668825=v1.17.0) 제거** 후 재설치.
  - 1차 `npm install`은 lock이 v1.17.0 커밋을 고정해 재사용됨(grep 0). lock 엔트리 삭제 후 재설치하여 해소.
- 결과: lock resolved `…#29dff6b…` (= `git ls-remote v1.18.0` 해시 일치), `version: 1.18.0`.
- 검증: `grep -c "student?.school" node_modules/@impact7/shared/student-label.js` → **2** (≥1 충족, school 폴백 반영).

## 2. 버그4 — updated_at 추가 지점
- `diagnostic.js` `_upsertStudentFromTemp` `baseFields`(238행 직후)에 `updated_at: serverTimestamp()` 1줄 추가.
- baseFields는 기존학생 merge(`auditSet(ref, baseFields, {merge:true})`)와 신규생성(`{...baseFields, status:'상담'…}`) **양쪽에서 사용** → 두 경로 모두 updated_at 기록. 버그2(목록 필터 사각지대) 근본 해소.
- `serverTimestamp`는 이미 4행에서 import됨 → 재사용(추가 import 불필요).
- 로컬 캐시(`state.allStudents`)에는 serverTimestamp sentinel이 들어가나 표시·필터에 무해.

## 3. 학교명 정규화 판단 → **raw 유지**
- DSC에 `normalizeSchoolName` 미존재. shared의 정규화 함수 `normalizeSchoolForLabel`는 **내부 함수(미export)**.
- students는 DB앱 마스터 도메인. 라벨 표시는 shared v1.18.0이 정규화 처리(접미사·지역명 제거)하므로 저장값 정규화는 필수 아님.
- 따라서 `SCHOOL_FIELD[level] = data.school` raw 저장 유지(코드 변경 없음). 향후 정규화가 필요하면 shared에서 함수 export 후 적용 권장.

## 4. 버그3 — visit-list 라벨 폴백 (코드 변경 불필요, bump로 자동 해결)
- `visit-list-render.js:64` `studentShortLabel(ta)` ← `src/shared/firestore-helpers.js:286`에서 shared `studentFullLabel` **그대로 re-export**.
- v1.17.0은 `student[SCHOOL_FIELD[predLevel]]`만 읽어 temp_attendance(school 단일, school_* 없음)에서 학교명 공백 → "초6"으로 깨짐.
- v1.18.0이 `|| student?.school` 폴백 추가 → bump만으로 해결.
- 표본 검증(`node` 직접 실행):
  - `{school:'신목초', level:'초등', grade:'6'}` → **신목초6** (이전 "초6")
  - `{school:'신목초등학교', …}` → 신목초6 (접미사 제거)
  - `{school:'서울염경중학교', 중등1}` → 염경중1 (지역명 prefix 제거)
  - `{school:'봉영여자중학교', 중등2}` → 봉영여중2
  - 정식학생 `{school_high:'광영고', 고등1}` → 광영고1 (회귀 없음)

## 5. 검증
- `npm run build` (vite) ✔ built in 15.09s, 에러 없음.
- `npm test` ✔ 19 pass / 0 fail.
- diff: `diagnostic.js`(+1), `package.json`(버전), `package-lock.json`(resolved 갱신).

## 제약 준수
- 커밋·푸시·배포 안 함. shared repo 무변경. temp_attendance rules에 school_* 추가 안 함(폴백으로 해결).
