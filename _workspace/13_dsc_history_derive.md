# 13. DSC 수업이력 — override 기반 내신/자유학기 표시 (2단계)

## 결과 요약
마법사 표준 학생(정규 + `naesin_class_override`)은 history_logs에 내신 로그가 없어 수업이력에 내신이 안 떴다.
공유 헬퍼 `deriveClassPeriodHistory`(@impact7/shared/enrollment-derivation **v1.8.0**)로 enrollments + class_settings에서
내신/자유학기 항목을 파생해 기존 "수업추가" 항목과 동일한 형태로 합성하도록 수정. **빌드 성공.**

## 변경 파일

### 1) `package.json` (1줄)
- `@impact7/shared`: `#v1.7.0` → `#v1.8.0`
- 강제 재설치: `rm -rf node_modules/@impact7/shared && npm install @impact7/shared`
- `package-lock.json` resolved 해시 갱신됨:
  `git+ssh://...impact7-shared.git#bef271e967811d6850107f47451a7e9a04181dfa` (version 1.8.0)
- 설치 검증: `node_modules/@impact7/shared/package.json` version = `1.8.0`,
  `deriveClassPeriodHistory` export 확인.

### 2) `class-history.js` (수업이력 빌더)
- **import 추가** (라인 14~16):
  - `deriveClassPeriodHistory` from `@impact7/shared/enrollment-derivation`
  - `state` from `./state.js`
  - `findStudent, branchFromStudent, enrollmentCode, displayCodeFromCsKey` from `./student-helpers.js`
- **`loadClassHistoryCard`** (라인 36): 로그 로드 후 `_deriveCardItems(studentId, logs)` 결과를
  `_renderClassHistory`의 세 번째 인자로 전달. (student-detail.js 호출부는 미변경 — `studentId`만 받음.
  학생 객체는 `findStudent`로 내부 조회.)
- **`_deriveCardItems(studentId, logs)`** (신규, 라인 49~70):
  - `findStudent(studentId)`로 학생(활성/비원생 모두) 조회 → `student.enrollments` + `state.classSettings`로
    `deriveClassPeriodHistory(enrollments, classSettings, { enrollmentCode })` 호출.
  - 중복 방지: 로그에서 `classifyHistory` 결과 중 `label === '수업추가'`인 `to` 코드 집합(`loggedCodes`)을 만들고,
    파생 항목의 원본 csKey 또는 표시코드가 이미 로그에 있으면 스킵.
  - (헬퍼 자체는 명시적 `class_type='내신'/'자유학기'` enrollment 존재 시 파생 안 함 — 1차 중복 방지.)
- **`_shortDate`** (신규, 라인 73~76): `'YYYY-MM-DD' → 'MM/DD'` 표시 헬퍼.
- **`_renderClassHistory(logs, container, derivedItems=[])`** (라인 79~):
  - 로그 항목과 파생 항목을 단일 `items` 배열로 통합. 각 항목은 `{ sortKey, badgeClass, label, change, meta }`.
  - 파생 항목: `label='수업추가'`, `change='→ <displayCodeFromCsKey(code, branch)>'`(branch 접두사 제거),
    `meta='<MM/DD(start_date)> · 자동'`. 렌더 형태는 기존 "수업추가" 항목과 동일(`history-item` + 동일 badge 클래스 `badge-enroll`).
  - **start_date(파생)/timestamp(로그) 기준 시간 역순(`sortKey` desc) 병합 정렬.**
  - 빈 상태/빈 컨테이너 분기는 통합 후 `items.length === 0` 한 곳으로 정리.

## DB와 동일 헬퍼 사용 확인
- DSC, DB 모두 `@impact7/shared` **v1.8.0** 동일 커밋(`bef271e9`) 사용.
  - DB: `/Users/jongsooyi/projects/impact7DB/node_modules/@impact7/shared` version 1.8.0.
  - DSC: 위 강제 재설치로 동일 버전·커밋 해시.
- 파생 로직은 공유 모듈 `deriveClassPeriodHistory` 단일 소스 — 앱별 복제 없음(파리티 확보).
- 호출 시 `enrollmentCode`는 DSC `student-helpers.js`의 것(level_symbol+class_number)을 주입 —
  DB도 동일 시그니처(`{ enrollmentCode }`)로 주입하는 설계.

## 빌드 결과
- `npm run build` (vite 7.3.1): **성공** (747 modules, ~5.6s).
- 500kB chunk 경고는 기존부터 있던 것(코드 스플릿 권고)이며 이번 변경과 무관.

## 범위 준수
- 변경 파일: `class-history.js`, `package.json`, `package-lock.json` 만.
- `student-detail.js`(성적 관련 포함) 및 그 외 파일 **미변경** (git status로 확인).
- `students` 컬렉션 쓰기 없음(읽기 전용 유지).

## 비고
- /simplify 1회 적용: `_deriveCardItems`의 `displayCodeFromCsKey` 중복 호출·brittle `change.replace('→ ', '')`
  dedup을 원본 csKey + 표시코드 직접 비교로 정리. 재빌드 성공.
- 커밋·푸시 안 함 (지시대로 보고만).
