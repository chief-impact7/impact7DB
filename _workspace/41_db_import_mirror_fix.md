# 41. DB import 스크립트 미러 잔여 + minor 수정

전역 school 미러 제거 후 코드리뷰(38_db_codereview.md)·QA(37_qa_crossapp.md) 발견 항목 처리.
커밋·푸시·배포 전 검토 단계. students 대량 write 없음(MINOR-2는 읽기 audit만).

## C2 (미러 재기록) — `upsert-students.js` : 수정 완료

admin SDK라 rules를 우회해 bare `school`을 students에 재기록하던 경로를 제거.

- `SCHOOL_FIELD`(@impact7/shared/student-label) import + app.js 동형 `toPersistFields(obj)` 헬퍼 추가
  (작업용 `.school` → `SCHOOL_FIELD[level]` 학부필드로 옮기고 `school` 키 `delete`).
- INSERT write: `data: incoming` → `data: toPersistFields(incoming)`.
- foundViaOldId set: `{ ...ex, ...updateData }` → `toPersistFields({ ...ex, ...updateData })`
  (구 doc에 남은 `school` 미러까지 학부필드로 흡수·삭제 — 마이그레이션 부수효과는 안전).
- `diffBasicInfo`: 비교 필드에서 `'school'` 제거, 대신 `SCHOOL_FIELD[level]` 학부필드와 비교해
  변경 시 그 필드를 diff에 기록(UPDATE merge가 학부필드로만 반영).
- `normalizeStudentSchools`는 미수정 — temp `.school` 정규화는 그대로 두고, write 직전 매핑으로 흡수.

→ 최종 write payload에 bare `school` 키 없음. 신규/변경 모두 school_* 만 기록. 미러 부활 차단.

## C3/M (import 깨짐) — `import-students.js` : 미사용 확인(수정 불요)

- 파일 1~9줄에서 `console.error('⛔ DEPRECATED …'); process.exit(1)` 로 **즉시 종료**.
  (2026-03-07 students 유실 사고 원인으로 차단됨, upsert-students.js로 대체.)
- `package.json` scripts에 `import` 타깃 없음. 호출처·문서 참조 0건.
- 실행 자체가 불가능하므로 permission-denied도 발생할 수 없음. **수정 대신 미사용 판정**.
  (구 미러 write 코드 L146/L183은 dead code.)

## MINOR-1 (학년승급 가드) — `app.js:4895`·`6290` : 수정 완료

트리거 `computeLabelUpdate`(functions-shared/src/studentLabelSync.js L7)의
`hasAnySchool = !!(school_elementary||school_middle||school_high)` 가드와 동일 조건을
로컬 라벨 동기화 두 곳에 추가:

- applyBulkPromotion: `if (s.school_elementary||s.school_middle||s.school_high) s.school_level_grade = studentFullLabel(s);`
- runPromotion: 동일 가드.

→ 학교 완전 미입력 학생에서 로컬이 무조건 `"고1"`로 덮어쓰던 문제 해소.
이제 학부필드 없으면 로컬도 미갱신 → 트리거(null 반환·기존값 보존)와 멱등 일치.

## MINOR-2 (필드 한도 35 마진) — audit 결과: 여유 충분, 조치 불요

admin 읽기 전용 스캔(students 15,675 docs):
- **worst-case 25 필드** (docId `고태원_1091516455`) — 35 한도 대비 **+10 여유**.
- 분포 최댓값 25, 30 초과 문서 **0건**, 34 초과 **0건**.
- bare `school` 키 잔존 문서 **0건** (미러 제거 완료 확인).

→ `withinFieldLimit(35)` 충분히 안전. 재상향 불요.

## 검증

- `node --check upsert-students.js` / `import-students.js` : OK.
- `npx vite build` : 성공 (36 modules, app.js 가드 변경 반영).
- upsert 최종 payload 논리 확인: `toPersistFields`가 모든 set 경로에 적용 → `school` 키 미기록,
  school_* 만 기록. UPDATE merge는 `diffBasicInfo`가 학부필드로 diff.

## 제약 준수

- 커밋·푸시·배포 안 함. MINOR-2는 읽기 audit만(임시 스크립트 작성→실행→삭제). 대량 write 없음.
