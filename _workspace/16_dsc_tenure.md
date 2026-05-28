# 16. DSC 재원기간 표시 (impact7newDSC)

학생 상세 수업정보(등원 일정 카드)에 "재원기간"을 추가했다. DB와 동일 SSoT 헬퍼
`deriveTenure`(@impact7/shared/history, v1.9.0)를 사용해 파리티를 맞췄다.

## 변경 파일

- `/Users/jongsooyi/projects/impact7newDSC/package.json`
  - `@impact7/shared` 핀을 `#v1.8.0` → `#v1.9.0` 으로 bump.
  - 강제 재설치 완료: `rm -rf node_modules/@impact7/shared && npm install @impact7/shared`
  - 설치본 검증: `node_modules/@impact7/shared/package.json` version=1.9.0, `history-classifier.js`에 `deriveTenure` 존재.
- `/Users/jongsooyi/projects/impact7newDSC/student-detail.js`
  - firestore import에 `orderBy, limit` 추가, `import { deriveTenure } from '@impact7/shared/history'` 추가.
  - 모듈 헬퍼 3개 추가: `_fmtTenureDate`(Date→YYYY-MM-DD, 로컬시간, DB formatDate와 동일), `formatTenure`, `fillTenure`. DB app.js의 `formatTenure`/`fillTenure`를 그대로 포팅.
  - 등원 일정 카드(`arrivalTimeHtml`) 최상단에 "재원기간" 행 + placeholder `#detail-tenure` 추가.
  - `cardsContainer.innerHTML` 설정 직후 `if (document.getElementById('detail-tenure')) fillTenure(studentId, student)` 호출.
  - 성적 등 무관 코드는 건드리지 않음.

## 로직 (DB와 동일 SSoT)

- `history_logs` where `doc_id == studentId` orderBy timestamp desc limit 200 → `deriveTenure(logs, getDate)`.
  getDate: `l.timestamp?.toDate ? l.timestamp.toDate() : (l.timestamp ? new Date(l.timestamp) : null)`.
  (class-history.js / DB app.js fillTenure와 동일한 조회 패턴.)
- `deriveTenure`: 신규/재등원 = 기간 시작, 퇴원 = 기간 끝, 휴원/복귀는 무시(안 끊음), 퇴원 후 재등원 = 새 기간. 반환 `{ start, end }`.
- 표시(formatTenure): start 없으면 `—`. END 규칙 — `end` 있으면 퇴원일,
  없고 status='종강'이면 `status_changed_at`(없으면 `updated_at`, 둘 다 없으면 '종강'),
  그 외 재원계열이면 `현재`. 결과 형식 `YYYY-MM-DD ~ END`.

## stale 방지

- `renderStudentDetail`은 동기 렌더. selectStudent에서 `state.selectedStudentId = id` 직후 `renderStudentDetail(id)` 호출됨.
- `fillTenure`는 비동기 조회 후 `if (state.selectedStudentId !== studentId) return` 가드로 다른 학생 전환 시 stale 반영 차단 (성공/실패 경로 모두). DB의 `currentStudentId !== studentId` 가드와 동치.

## 검증

- `npm run build` 성공 (747 modules transformed, built in ~4.6s; 사전 존재하던 chunk-size 경고만, 에러 없음).
- 김민주4(docId=김민주4_1037084881, status=재원, history_logs 5건) → 설치된 v1.9.0 `deriveTenure` + 본 `formatTenure`로 실제 Firestore 조회 결과:
  - start=2026-03-06, end=null → **재원기간 = `2026-03-06 ~ 현재`** ✅ (기대값 일치)
  - 검증은 임시 oneoff 스크립트(firebase-admin, 설치본 헬퍼 import)로 수행 후 삭제.
- 파리티: DSC와 DB의 `node_modules/@impact7/shared/history-classifier.js` **byte-identical** (diff -q 동일) → 동일 헬퍼 사용 확인. DB app.js도 `import { ... deriveTenure } from '@impact7/shared/history'` 사용.

## 미수행 (지시대로)

- 커밋·푸시 안 함. 보고만.
- students 컬렉션은 읽기만 함 (history_logs 조회만, 쓰기 없음).
