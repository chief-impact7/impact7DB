---
name: contacts 컬렉션 폐기 — impact7DB Phase 5 완료
description: app.js에서 contacts 읽기/쓰기 모두 제거. 과거 학생(퇴원/종강) 검색은 students 캐시 로컬 필터로 전환 — 2026-04-09
type: project
---

## 완료 상태 (2026-04-09)

impact7DB와 impact7newDSC 양쪽 모두 contacts 컬렉션을 더 이상 읽거나 쓰지 않음. Firestore `contacts` 컬렉션은 백업 후 drop 가능 상태.

### impact7DB 변경 내역 (2026-04-09)
- `searchContacts` → `searchPastStudents`: Firestore 'contacts' prefix 쿼리 제거, `allStudents` 로컬 캐시에서 status in ['퇴원','종강'] 동기 필터.
- `_tryContactAutofill` → `_tryPastStudentAutofill`: `getDoc(students/{docId})` 네트워크 호출 제거, `allStudents.find(s => s.id === docId)`로 로컬 조회. 자동채움 즉시 반응.
- `submitNewStudent`의 contacts setDoc(merge) 블록 제거.
- `saveGrammarSpecial`의 batch contacts setDoc 제거 (문법 특강 신규등록 시).
- `renderStudentList`/`renderContactResults` → parameter `pastResults` / `renderPastStudentResults`로 rename.
- 1회용 마이그레이션 스크립트 9개 삭제: `_backfill_consult_students.cjs`, `_check_diff_contacts_students.cjs`, `_check_drift_details.cjs`, `_check_hwang.cjs`, `_delete_hwang_dup.cjs`, `_delete_orphan_contact.cjs`, `_merge_drift_dryrun.cjs`, `backfill-students.js`, `import-contacts.js`.

**Why**: contacts는 students와 1:1 병합이 완료되어 있고, DSC는 이미 첫데이터입력 시 students에 '상담' 상태로 직접 upsert하도록 변경됨. impact7DB도 contacts에 쓰는 경로를 모두 끊어 drop 준비 완료.

**How to apply**:
- 향후 "과거 학생 검색" 이슈는 `searchPastStudents` + `allStudents` 캐시 흐름을 봐야 함 (Firestore 쿼리 아님).
- 자동채움은 로컬 캐시에서 읽으므로 퇴원 학생이 allStudents에 로드되어 있어야 동작. `loadStudentList`는 전체 students 컬렉션 로드이므로 문제 없음.

## 남은 작업
- firestore.rules의 `match /contacts/{docId}` 블록은 **컬렉션 drop 이후** 제거. 4개 프로젝트(DB/DSC/HR/exam) 동기 필수.
- 며칠 모니터링하여 contacts에 신규 write가 없는지 확인.
- 백업 → contacts 컬렉션 drop.
- docs/plans/2026-03-03-contacts-master-db*.md는 역사적 문서로 보존 (archived plan). `docs/system-overview.md`의 contacts 섹션은 향후 drop 후 업데이트 예정.
