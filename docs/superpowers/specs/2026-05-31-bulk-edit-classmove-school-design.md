# 일괄수정 개선 — 반 이동 + 학교이름 변경 (Design)

작성: 2026-05-31 · 대상: impact7DB 일괄수정(우측 패널) · 단일 앱(DSC 미지원)

심예율 핸드오프와 별개. 일괄수정 패널에 4개 개선.

## 요청 & 결정
1. **"반 변경" → "반 이동"** 이름 변경 (UI 제목 + 문구).
2. **반이동 시작일** 추가. (Q2: 입력 시 갱신, 비우면 기존 유지)
3. **없는 반 이동 금지** + alert. (Q1: 같은 학기 정규반 집합 기준)
4. **새 카드 "학교이름 변경"**: 초/중/고 선택 + 새 학교명 → 선택 학생 일괄. (Q3: 선택 학부 school_*만, level/grade 미변경. Q4: 빈값 금지)

## 접근
- 반 이동(1~3): 기존 `applyBulkClass`(app.js:4671) 수정. `moveClass`(shared) **무변경** — 시작일은 app.js에서 후처리.
- 학교이름 변경(4): `window.applyBulkSchool` 신규 + 새 카드. 기존 일괄수정 카드와 동일 패턴(공유상태 `selectedStudentIds`/`allStudents` 깊은 의존 → app.js 응집, 모듈 분리 우선순위 낮음).

## 설계

### ① 반 이동 (`index.html` 반 변경 카드 + `applyBulkClass`)
- **UI**: 카드 제목 `반 변경`→`반 이동`. 반코드 input 아래/옆에 **시작일 `date` input**(`id=bulk-class-startdate`, 선택). 적용/초기화 유지.
- **문구**: confirm `…정규반을 '${raw}'(으)로 변경합니다`→`…정규반을 '${raw}'(으)로 이동합니다`. 완료 alert `…반을 …변경했습니다`→`…이동했습니다`. history `after: 반: …(일괄변경)`→`(일괄 이동)`.
- **없는 반 가드**: 적용 시작 시, 입력 반코드(`raw`=levelSymbol+classNumber)가 **현재 활성 학생들의 선택 학기 정규 enrollment 반코드 집합**에 없으면 `alert('존재하지 않는 반입니다: ${raw}\n현재 ${sem} 정규반에 있는 반코드로만 이동할 수 있습니다.')` 후 return. 집합 = `allStudents` 중 status 활성 + 해당 학기 정규 enrollment의 `enrollmentCode`. (오타·신설 방지)
- **시작일**: `bulk-class-startdate` 값이 있으면, 각 학생 `moveClass` 결과 `updatedEnrollments`에서 **이동된 정규 enrollment(해당 학기)** 의 `start_date`를 그 값으로 덮어씀. 비우면 미변경(moveClass가 보존).

### ② 학교이름 변경 (새 카드 + `applyBulkSchool`)
- **UI**(새 `bulk-edit-section`, 반 이동 카드 근처): 제목 `학교이름 변경`(icon `school`). **초/중/고 라디오**(`name=bulk-school-level`, 값 `초등|중등|고등`, 기본 미선택 또는 중등). 학교명 input(`id=bulk-school-name`). 적용→`applyBulkSchool()`, 초기화→`resetBulkSchool()`.
- **applyBulkSchool**:
  - 과거학기/선택0명 가드(기존 카드와 동일).
  - 학부 라디오 미선택 → `alert('학부(초/중/고)를 선택하세요.')` return.
  - 학교명 `trim()` **빈값 → `alert('학교명을 입력하세요.')` return**(Q4).
  - `normalizeSchoolName(입력, level, knownSchools)` 정규화(saveStudent와 동일). `SCHOOL_FIELD[level]` = `school_elementary|middle|high`.
  - confirm(`선택한 N명의 <학부> 학교를 '<정규화명>'(으)로 설정합니다.`).
  - batch update: 각 학생 `{ [SCHOOL_FIELD[level]]: 정규화명 }`. `history_logs` UPDATE(`before: <학부>학교: <기존>`, `after: <학부>학교: <정규화명> (일괄)`).
  - 로컬 캐시: `s[SCHOOL_FIELD[level]]=정규화명`, `s.school_level_grade=studentFullLabel(s)`(학년승급 패턴, 트리거도 자동 갱신).
  - `student.level`/`grade` **미변경**.
- 200건/배치, 완료 alert.

## 비고
- `moveClass`/shared 무변경 → 버전 bump 불필요.
- rules: students whitelist에 `school_*`·`start_date`·`enrollments` 모두 허용됨(전역 전환·기존). 신규 필드 없음.
- 데이터 마이그레이션 없음.
