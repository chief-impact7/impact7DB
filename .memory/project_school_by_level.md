---
name: school-by-level
description: 학부별 학교명(school_elementary/middle/high) + school_level_grade 라벨 도입. studentFullLabel 정규화 규칙(약어·지역명·예외) SSoT
metadata:
  type: project
---

# 학부별 학교명 + school_level_grade 라벨 (2026-05-30 Phase 1 배포)

## 데이터 모델
- 학교명 = **학부별 3필드** `school_elementary` / `school_middle` / `school_high` (빈값=모름). 진학(초6→중1)해도 이전 학부 학교 보존.
- 단일 `school`은 **현재 학부 미러**(Phase 1 호환 — 전역 앱 DSC/exam이 아직 읽음). Phase 2에서 제거 예정.
- `school_level_grade` = "봉영여중1" 라벨(검색·정렬·표시용).

## 공유 로직 (`@impact7/shared/student-label`, v1.14.0)
- `currentSchool(student)` = `student[SCHOOL_FIELD[level]]`. `SCHOOL_FIELD = {초등:school_elementary, 중등:school_middle, 고등:school_high}`.
- `studentFullLabel(student)` (**v1.15.0~ 예측 학부 기준**) = `normalizeRealLevelGrade`로 매년 진급 반영한 **예측 학부**(졸업→고등)의 학교 정규화 + 학부글자 + 학년. **예측 학부 학교 미입력이면 학교 없이**(`고1`, `고(졸업+6)`). `currentSchool`(=student.level=최종 기록 학부)은 **미러용으로만** 씀(다녔던 학교). **정규화 규칙(수정은 이 모듈에서만):**
  - 접미사 제거: `(초등학교|중학교|고등학교|학교)$`
  - 약어(긴 것 우선): 사범대부속→사대부, 여자→여, 외국어→외, 부속→부
  - 지역명 prefix 제거 17개(서울·경기·인천·부산·대구·광주·대전·울산·세종·강원·충북·충남·전북·전남·경북·경남·제주). 단 제거 후 빈값이거나 학부글자(초/중/고) 1글자면 원복. 예: 서울목동중→목동중, 서울중→서울중.
  - 학부글자 중복 제거(양명초→양명+초=양명초). **단 예외 14개는 학부글자 유지**: 초 서초·활초·소초·속초·시초·도초·백초·생초·연초 / 중 윤중·안중·영중·운중·아중. (고 예외 없음) 예: 서초→서초초, 윤중→윤중중.
  - 졸업(예측=고 이후): `학교고(졸업+N)`, 고 학교 미입력이면 `고(졸업+N)`.

## 트리거 (`functions-shared` onStudentLabelSync, 배포됨)
- students write 시 currentSchool→`school` 미러 + studentFullLabel→`school_level_grade` 동기화. 변경 시에만 write(무한루프 방지).
- **가드(v1.15.0~): 학부별 필드(elementary/middle/high)가 하나도 없을 때만 skip**(미마이그레이션). 진학/졸업 예측 학생(예측 학부 학교 없어도 학부필드 있음)은 라벨 생성. (구: currentSchool 빈값 skip → 예측 학부 도입으로 완화)
- 경로 무관(편집·학년승급·import·진단평가) 발화.

## 입력 / 학년승급 (impact7DB)
- 폼: 현재 학부 학교 1칸(`school_current`) + 이전 학부 접기(`<details>`). saveStudent가 현재 level 필드 + 미러 저장, **모든 학부 필드에 normalizeSchoolName 적용**.
- `applyBulkPromotion`: 학부 전환 시 새 학부 필드에 학교, **이전 학부 필드 보존**.

## 마이그레이션 (완료)
- Phase 1: 현재 학기 333건만(누적 졸업오판 회피). **Phase 2-B: 예측 학부 기준 전환 후 전체 15,032건 백필**(현재학기 제한 해제, status 무관). single school → 최종 기록 학부 필드, 라벨=예측 학부 기준(누적 데이터도 `고(졸업+N)` 정확).
- 스크립트: `migrate-school-by-level.js` (`npm run migrate:schoollevel[:run]`).

## Phase 2 (TODO)
- ✅ **퇴원생 grade 누적(B) 완료**(2026-05-30, Phase 2-B): studentFullLabel을 예측 학부 기준으로 전환 → 누적 데이터도 `고(졸업+N)` 정확. status는 '퇴원' 유지(졸업 신규 없음). 목적=졸업생 현재상태 예측으로 동생·친척 연관 상담. 상세: predicted-level-label spec/plan.
- **전역 전환** = 각 앱 자체 학교 라벨 함수를 `@impact7/shared`(studentFullLabel/currentSchool)로 통일하는 작업(단순 .school 치환 아님). 사용자 결정: **예측 학부 기준 전면 수용**(DB와 동일 라벨, 진급·졸업 반영). DSC→exam 순서.
  - ✅ **DSC 완료**(2026-05-30, 커밋 b431c80 배포): `studentShortLabel`=`studentFullLabel` 재노출(표시 8곳), `schoolSearchTerms` 예측 학부 학교+학년 기반 재작성(검색 4곳, 표시-검색 SSoT 정규화 공유), shared v1.12.0→v1.15.0, dead code 5함수 제거. 빌드+테스트19/19, 라벨 diff 정상학생 변동 0건. 분석/구현: `_workspace/18`,`20`.
  - ✅ **exam 완료**(2026-05-30, 커밋 1249ead 배포): `formatSchoolShort`=`studentFullLabel` 래퍼(growth-report 등 호출부 무변경), `schoolSearchTerms` 예측 기준 재작성, `@impact7/shared#v1.15.0` 추가 + **로컬 ambient `.d.ts`**(`src/shared/types/impact7-shared.d.ts`, shared repo 무수정)로 TS 타입 보강, `Student`에 school_* 추가. **경계 엄수**: `ExamAnalysis`·`ExternalScoreEvent` 자체 school·`isSameSchoolName` 매칭·`ExternalScorePanel` 전부 미변경. tsc any 0·next build 45p·재원 349건 변동 0건. 구현: `_workspace/21`.
  - **전역 전환 표시·검색 부분 완료**(DB·DSC·exam 3앱 동일 SSoT 라벨). 남은 후속: ①구 `school` 단일 미러 **제거**(이제 모든 앱이 school_* 사용 → 가능, 단 exam은 미러 의존 잔여 없는지 최종 확인 후) ②검색어 `studentSearchTerms` **shared 공통화**(현재 DSC·exam 각자 로컬 동일 패턴, v1.16.0 후보) ③학년승급 로컬캐시(allStudents) 학부별 필드 동기화.
- ⏳ **후속 1번: 구 `school` 미러 제거 진행 중**(영향분석 `_workspace/22`, 위험도 높음). 사용자 결정: rules 버그 선결→미러제거 블로커 단계별, newtest는 자체 수정, 데이터는 **dead data 보존**(15,032건 삭제 안 함).
  - ✅ **선결 rules 버그 수정 완료**(2026-05-30, DB 4d7d50b 배포·4앱 동기화): students allowed에 `school_*`·`school_level_grade`·`enrollments_cleared_at/by` 누락 → 폼 저장 reject 현존 버그. `withinFieldLimit` 30→35. 교훈 [[feedback_student_field_rules_sync]]. 상세 `_workspace/23`.
  - ⏳ **미러 제거 블로커 (①완료, ②③ 남음)**(읽기→currentSchool 전환 후 쓰기 중단): ✅①**exam `ExternalScorePanel` 완료**(2026-05-30 d643465 배포): `studentSchool()`→currentSchool, exam students 미러 의존 0. event.school 자체도메인·isSameSchoolName 매칭 현행. 재원 일치율 99.75%. `_workspace/24`. ✅②**DB+DSC 내신 CS키 동시 이전 완료**(2026-05-30 배포: DB functions:leave-request firebase deploy + DB 7b46f48 + DSC 8a8cad6). csKey 생성 4곳(DB fn `naesinHelpers.deriveNaesinCode`, DSC 루트 `student-helpers.deriveNaesinCode`=실제 생성주체, DSC React `DailyLogBoard.buildNaesinKey`) + 독립 `naesin-schedule`(csKey 아님). **세 csKey 식 글자단위 동일**: `branch+school+levelShort+grade+group`(구분자 0), `.school`→`currentSchool`만 교체. functions는 shared 미의존→inline 미러(shared 정의와 글자동일 `student?.[SCHOOL_FIELD[level]]||''`). **무중단**(정상학생 키 보존). 게이트=stale audit(활성 0/키변동 0, 배포직전 재확인). 분석 `_workspace/25`, audit `_workspace/26`+`audit-naesin-stale.mjs`, 구현 `_workspace/27`,`28`. ✅③**newtest cloudrun 완료**(2026-05-30, `gws-impact7-cli` 프로젝트 커밋 a6196a2·revision 00068-nw6 배포). `cloudrun/src/index.js` `upsertDscStudentFromTemp` baseFields에 학부별 필드 주입(`SCHOOL_FIELD_BY_LEVEL[data.level]`=data.school). 진단평가 생성 students가 school_* 보유 → 미마이그레이션 doc 생산 중단·트리거 가드 통과. 미러 school은 최종단계까지 유지. **주의: newtest는 별도 GCP `gws-impact7-cli` 배포(impact7db 아님), Firestore는 SA키로 impact7db 접근. 배포=`gcloud run deploy newtest-chat-handler --project=gws-impact7-cli`.**
  - **블로커 ①②③ + 마무리 2단계 전부 완료** ✅ → **구 school 미러 완전 제거**(2026-05-30, DB 026e6ec + functions:shared 배포).
    - 마무리 단계1(read 전환): app.js(abbreviateSchool·과거학생폼·상세·시트export·승급폴백)·school-normalizer·past-history·promo-extractor·consultationAiHandler→currentSchool. autofill `_form.school` undefined throw 버그도 `school_current`로 교정. `schoolOf=currentSchool(s)||s?.school` 방어 fallback 유지.
    - 마무리 단계2(write 중단): onStudentLabelSync 미러 write 삭제(school_level_grade 라벨 write 유지), saveStudent/applyBulkPromotion/import/시트 payload의 `school` 키 제거(school_* 저장 유지). 게이트=미러 순수 read 0 grep. 구현 `_workspace/29`.
    - **이후 students write에 school 미러 미생성.** 데이터 15,032건 school은 **dead data 보존**(삭제 안 함).
- **전역 전환 잔여 진행 중**:
  - ✅①**rules school 제거 완료**(2026-05-30, DB 44bad8a 배포·4앱 동기화): 데이터 15,675건 **백업(`_workspace/school-mirror-backup.json` 롤백근거) 후 전수 deleteField 삭제**(잔여 0, 활성 손실 0, 위험 38건은 퇴원/상담 깨진값), rules allowed에서 `school` 제거. newtest cloudrun도 미러 write 제거·재배포(00069-vws). **구 school 미러 데이터·코드·rules 완전 소멸.** audit `_workspace/31`, 실행 `_workspace/32`.
  - ✅②**검색어 shared 공통화 완료**(2026-05-30, shared v1.16.0 태그·push + DB 0fd91b0·DSC cfeb812·exam 9fc88e2 배포): `student-label.js`에 `studentSearchTerms`(exam 정본, 빈학교+Set중복제거) 추가, 3앱 로컬 `schoolSearchTerms`를 `export { studentSearchTerms as schoolSearchTerms }` 재노출로 교체(callsite 무수정). **DB만 raw 합성이던 검색 회귀를 정규화 기준으로 교정**(표시-검색 일치). exam .d.ts는 인덱스시그니처 TS2345 회피 위해 실제 읽는 필드만 선언. github 캐시 함정(v1.15.0 고정) 강제재설치로 교정. 분석 `_workspace/30`, 구현 `33`(exam)`34`(DSC)`35`(DB).
  - ✅③**학년승급 로컬캐시 동기화 완료**(2026-05-30, DB d1370ad): `applyBulkPromotion`·`runPromotion`이 로컬 allStudents에 grade/level/school_*는 반영했으나 트리거가 쓰는 `school_level_grade`만 stale → 두 경로에 `s.school_level_grade = studentFullLabel(s)` 추가(멱등, 트리거 후속 write no-op). 화면 라벨은 원래 라이브 계산이라 정확, 검색/denormalized 필드 stale만 해소. 구현 `_workspace/36`.
- ✅✅ **전역 전환 전 항목 완료**(표시·검색 3앱 통일 + rules 버그 + 구 school 미러 완전 제거[데이터·코드·rules] + 검색어 shared 공통화 v1.16.0 + 학년승급 캐시). DB·DSC·exam·newtest·shared·functions(leave-request·shared) 전부 배포. 미러 백업 `_workspace/school-mirror-backup.json` 보존.
- ✅ **사후 code review로 미러 잔여 버그 수정**(2026-05-30, DSC 8efac71·DB e9b8402): 영향분석 22가 **인앱 보조 경로를 놓쳐** 미러 삭제+rules 제거 배포 후 다음이 깨졌던 것을 qa-validator+code review로 발견·수정 → [[feedback_field_removal_inapp_paths]]:
  - 🔴 DSC `diagnostic.js` 진단평가 upsert가 school client write → **permission-denied 차단** → SCHOOL_FIELD 매핑.
  - 🔴 DB `upsert-students.js`(admin)가 bare school **재기록**(미러 부활) → toPersistFields 매핑.
  - 🟠 DSC `daily-ops`/`export-report`/`past-history`가 사라진 s.school read → currentSchool/schoolSearchTerms 전환.
  - 🟡 학년승급 라벨 동기화에 hasAnySchool 가드 추가(학교미입력 멱등). `import-students.js`는 deprecated 미사용. withinFieldLimit worst 25/35 여유.
  - ⏳ **별건(선재, 전역전환 무관)**: DSC `DailyLogBoard.getBranch`(enrollments[0] 기준)가 정본 `branchFromStudent`(정규/자유학기)와 분기 → 내신 csKey branch 잠복 불일치 가능(2026-05-16 도입). 정본 단일화 필요. 검증 `_workspace/37`, 수정 `40`·`41`.
  - **배포 체크리스트(내신키류)**: 배포 직전 `node _workspace/audit-naesin-stale.mjs`로 활성 내신 stale=0 재확인(진급·newtest발 stale 상시 재발 가능).
- ⏳ 학년승급 로컬 캐시(allStudents) 학부별 필드 동기화(현재는 트리거/리로드 의존).

## 문서
- Phase 1 설계/계획: `docs/superpowers/specs/2026-05-30-school-by-level-design.md`, `docs/superpowers/plans/2026-05-30-school-by-level.md`
- Phase 2-B(예측 학부) 설계/계획: `docs/superpowers/specs/2026-05-30-predicted-level-label-design.md`, `docs/superpowers/plans/2026-05-30-predicted-level-label.md`

[[feedback_shared_version_conflict]] [[feedback_db_dsc_parity]] [[project_naesin_free_derivation]]
