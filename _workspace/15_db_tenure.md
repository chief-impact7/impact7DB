# 15. impact7DB 학생 상세 — 재원기간 표시

## 목표
학생 상세 "수업 정보" 카드에 **재원기간**을 표시한다.
- 정의: 등록(신규)/재등원 → 퇴원/종강.
- 휴원/복귀는 기간을 끊지 않음.
- 퇴원 후 재등원은 새 기간.
- 공유 헬퍼 `deriveTenure`(@impact7/shared/history, v1.9.0)로 history_logs에서 파생.

## 변경 파일
| 파일 | 변경 |
|------|------|
| `package.json` | `@impact7/shared` `#v1.8.0` → `#v1.9.0` |
| `package-lock.json` | 재설치로 갱신 |
| `index.html` | 수업 정보 카드에 "재원기간" 필드 행 추가 (`#profile-tenure`) |
| `app.js` | `deriveTenure` import / `fillTenure`·`formatTenure` 추가 / `selectStudent`에서 호출 |

## 구현 상세

### 1) 의존성 bump + 강제 재설치
```
package.json: "@impact7/shared": "github:chief-impact7/impact7-shared#v1.9.0"
rm -rf node_modules/@impact7/shared && npm install @impact7/shared
```
설치 후 검증: `node_modules/@impact7/shared/package.json` version=1.9.0,
`history-classifier.js`에 `export function deriveTenure(logs, getDate)` 존재 확인.

### 2) index.html (수업 정보 form-card, 통합 등원요일 행 아래 / 휴원 기간 행 위)
```html
<div class="form-field">
    <span class="field-label">재원기간</span>
    <div class="field-value" id="profile-tenure">—</div>
</div>
```

### 3) app.js
- import 추가: `deriveTenure` (기존 `@impact7/shared/history` import 라인에 합류).
- `selectStudent`: 수업 정보 카드 렌더(profile-pause-row) 직후 `fillTenure(studentId, studentData)` 호출.
- 신규 함수 `fillTenure`(loadHistory 바로 다음에 배치):
  - placeholder `…` 설정 후 history_logs 조회 (`where('doc_id','==',studentId)`, `orderBy('timestamp','desc')`, `limit(200)` — loadHistory와 동일 패턴).
  - 조회 직후 `currentStudentId !== studentId`면 즉시 return → stale 방지 (빠르게 다른 학생 클릭 시 이전 결과가 안 남음).
  - `deriveTenure(logs, l => l.timestamp?.toDate ? l.timestamp.toDate() : (l.timestamp ? new Date(l.timestamp) : null))` → `{start, end}`.
  - `formatTenure(start, end, studentData)` 결과를 `#profile-tenure`에 표시.
  - 에러 시에도 currentStudentId 가드 후 `—` 표시, console.warn.
- 신규 함수 `formatTenure(start, end, studentData)`:
  - `start` 없으면 `'—'`.
  - 있으면 `formatDate(start) ~ END`.
  - END 규칙 (중첩 삼항 없이 if/else if/else):
    - `end` 있으면 → `formatDate(end)` (퇴원).
    - `end` 없고 `status === '종강'` → `status_changed_at`(없으면 `updated_at`)을 Date로 변환해 `formatDate`, 변환 실패 시 `'종강'`.
    - 그 외(재원계열) → `'현재'`.
- 날짜 포맷은 기존 `formatDate`(YYYY-MM-DD) 재사용 → 표시 예: `2026-03-06 ~ 현재`.

## stale 방지 설계
selectStudent는 동기 렌더이고 fillTenure만 비동기다. getDocs 완료 직후
`currentStudentId === studentId`인지 확인하여, 그 사이 다른 학생이 선택됐으면
DOM을 건드리지 않는다. placeholder(`…`)는 매 선택 시 동기적으로 먼저 깔리므로
이전 학생의 값이 잔류하지 않는다.

## 모듈 분리 규칙 검토
파생 로직 자체(`deriveTenure`)는 이미 공유 모듈(SSoT). app.js에 추가한 것은
그 호출 래퍼(history_logs 조회 + DOM 표시)이며, selectStudent(동기 렌더)·
currentStudentId·formatDate에 긴밀히 결합되고 loadHistory 조회 패턴과 동일하다.
따라서 loadHistory 바로 다음에 배치해 응집도를 높였다. (별도 모듈로 빼면
db/firestore 핸들·currentStudentId·formatDate를 모두 주입해야 해 오버헤드가 큼.)

## 검증
- 빌드: `npx vite build` → 성공 (34 modules transformed, 에러 없음).
  경고(chunk>500kB, help-guide.js)는 기존부터 존재, 이번 변경과 무관.
- 김민주4 케이스 로직 추적:
  - 3/6 신규 → deriveTenure start = 2026-03-06, end = null
  - 5/14 가휴원 → classifyHistory '휴원' → deriveTenure 무시 (기간 안 끊음)
  - 5/20 복귀 → classifyHistory '복귀' → deriveTenure 무시
  - 퇴원 없음 → end = null
  - status = 재원계열(≠'종강') → formatTenure END = '현재'
  - **결과: `2026-03-06 ~ 현재`** (5/20 아님) — 요구사항 일치.
  - 실제 UI 표시는 history_logs 데이터에 따라 selectStudent 시 확인 필요(브라우저 검증 미수행).

## 미수행 / 후속
- 실제 브라우저에서 김민주4 선택 시 표시값 육안 확인은 미수행(코드 로직 추적으로 대체).
- 커밋·푸시 안 함 (지시대로 보고만).
