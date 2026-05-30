# 32. 구 `school` 미러 필드 백업 → 전수 삭제 → rules 정리 (실행 기록)

- 일자: 2026-05-30
- 승인: 사용자 명시 승인 (안전성 검증: `_workspace/31_school_delete_safety_audit.md`, 활성 손실 0).
- SA: `migrate-school-by-level.js`와 동일(`service-account.json`, projectId `impact7db`).
- 스크립트: `_workspace/school-delete-backup.mjs`(백업), `school-delete-execute.mjs`(삭제), `school-delete-verify.mjs`(검증).

## 단계 1 — 백업 (완료)

- 대상: `students` 전수 스캔, `school` 키 보유 문서의 `{docId, school, level, school_elementary, school_middle, school_high}`.
- **백업 건수: 15,675건** (전체 students 15,675건 전수가 `school` 키 보유).
- 백업 경로: `/Users/jongsooyi/projects/impact7DB/_workspace/school-mirror-backup.json` (2,818,145 bytes).
- 유효성: JSON 파싱 OK, 배열 15,675, 스키마 일치(docId/level/school/school_elementary/school_high/school_middle), docId 고유·누락 0.
- audit 31 분류와 정합: 사본 15,365 + empty 272 + 위험 38 = 15,675.

## 단계 2 — 삭제 (완료)

- 방식: `school` 키 보유 전 문서에 `{ school: FieldValue.delete() }` (키만 제거, 타 필드 불변). `school_elementary/middle/high`·`school_level_grade` 미접촉.
- writeBatch **200건/배치, 79배치 순차 commit**.
- **총 삭제: 15,675건** (배치 79/79까지 전부 정상 commit).
- 비고: 첫 시도에서 `FieldValue.deleteField()`(미존재 API) 오타로 **commit 전** TypeError 발생 → 삭제 0건(부분삭제 없음). `FieldValue.delete()`로 정정 후 재실행하여 완주.
- empty(272)·사본(15,365)·위험(38) 전부 포함. 위험 38건은 audit대로 학부필드 공란이라 키만 제거되고 손실 허용(원값은 백업에 보존).

## 단계 3 — 삭제 검증 (완료)

- 전수 재조회 결과 **`school` 키 잔여: 0건**.
- 학부필드/라벨 보존 sanity: school_elementary 2,965 · school_middle 9,445 · school_high 2,955 · school_level_grade 15,365 (삭제 전후 불변, 라벨 손상 없음).

## 단계 4 — rules 수정 (배포 금지, 컴파일만)

- `firestore.rules`의 `hasOnlyAllowedStudentFields()` allowed 배열에서 students용 `'school'`만 제거.

```diff
       function hasOnlyAllowedStudentFields() {
         let allowed = [
-          'name', 'level', 'school', 'grade',
+          'name', 'level', 'grade',
           'school_elementary', 'school_middle', 'school_high', 'school_level_grade',
```

- 보존 확인: `temp_attendance`(line 560/574/575)·`contacts`(line 623)의 자체 `school`은 미접촉. `school_elementary/middle/high/school_level_grade` 유지.
- **dry-run 결과:** `firebase deploy --only firestore:rules --dry-run --project impact7db` → `rules file firestore.rules compiled successfully` / `Dry run complete!`. **실제 deploy·4앱 동기화·커밋 미실행.**

## 트리거 거동 관찰 (onStudentLabelSync)

- 79배치 순차 commit이 비정상 지연·에러·재시도 폭주 없이 전부 통과. 과도한 추가 write 징후 없음.
- 검증 단계에서 `school_level_grade`(15,365) 불변 확인 → audit 31 예측대로 라벨 무변경 → `computeLabelUpdate` null 반환 → 트리거 재write 없음.

---

## 결과 요약

백업 15,675건(school-mirror-backup.json, 유효 JSON 검증 완료) → 삭제 15,675건(79배치) → 잔여 0건 → rules dry-run OK. 학부필드·라벨 전부 보존, 트리거 폭주 없음.

## 다음 (오케스트레이터 조율)

1. `firestore.rules` 실제 배포: `firebase deploy --only firestore:rules --project impact7db`.
2. rules 4앱 동기화: `firestore-rules-sync`로 DB/DSC/HR/exam 반영.
3. 변경 커밋(rules diff + 본 산출물). 롤백 필요 시 `school-mirror-backup.json`으로 복원 가능.
