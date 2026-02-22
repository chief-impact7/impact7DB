# impact7DB Dashboard — AI 인수인계 문서 (최종 갱신: 2026-02-22)

## 프로젝트 개요

Impact7 학원 학생 관리 시스템 (impact7DB)

| 항목 | 내용 |
|---|---|
| Firebase 프로젝트 ID | `impact7db` |
| GitHub 저장소 | https://github.com/chief-impact7/impact7DB |
| 개발 서버 실행 | `npm run dev` → http://localhost:5174 (WSL: `--host` 옵션으로 Network 주소 사용) |
| 스택 | Vite + Firebase v9 모듈 SDK + Vanilla JS |
| 메인 파일 | `index.html`, `app.js`, `style.css` |

---

## 파일 구조

```
impact7DB2AIs/
├── index.html           # 메인 UI (사이드바 + 목록 패널 + 상세/폼 패널 + 메모 모달)
├── app.js               # 메인 로직 (인증, 목록, AND 복합필터, 등록/수정 폼, 메모 모달, 이력 탭)
├── style.css            # 스타일 (MD3 + 필터 칩 + 메모 카드 + 모달 + 이력)
├── firebase-config.js   # Firebase 초기화 (import.meta.env.VITE_* 사용)
├── auth.js              # Google 로그인/로그아웃 (다중 도메인 지원)
├── vite.config.js       # Vite 번들러 설정 (host: true, usePolling: true for WSL)
├── .env                 # VITE_FIREBASE_* 환경변수 (git 제외됨)
├── .gitignore
├── firestore.rules      # Firestore 보안 규칙 (email_verified + 도메인 regex 검증)
├── firestore.indexes.json # 복합 인덱스 (history_logs: doc_id + timestamp)
├── import-students.js   # CSV → Firestore 대량 import (node로 실행)
├── students.csv         # 학생 명단 (399명)
├── PATCH_NOTES.js       # 변경 이력
├── apps/                # 레거시 — Gemini 프로토타입 (미사용)
├── core/                # 레거시 — apps/ 전용 Firebase 모듈 (미사용)
└── userlog.js           # 레거시 — 구 student_id 기반 감사 로그 (미사용)
```

---

## 핵심 아키텍처 결정사항 (반드시 숙지)

### 1. Firestore docId 방식

```
docId = 이름_부모연락처1(숫자만)_branch
예시: 김민준_01012345678_2단지
```

- `student_id` 필드 없음 (완전 제거됨)
- `branch` 값은 `level_symbol`에서 자동 파생 (`branchFromSymbol()` 참고)
- 재등록/반변경: 동일 docId → 필드만 업데이트 (중복 없음)

```js
const makeDocId = (name, parentPhone, branch) => {
    const phone = (parentPhone || '').replace(/\D/g, '');
    return `${name}_${phone}_${branch}`.replace(/\s+/g, '_');
};
```

### 2. branch 자동 결정

```js
const branchFromSymbol = (sym) => {
    const first = (sym || '').trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
};
```

- 폼에 단지 드롭다운 없음. 레벨기호 입력 시 자동 결정됨.

### 3. day 필드 — 배열로 저장

```js
// Firestore 저장: ["월", "수", "일"]
const normalizeDays = (day) => {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
};
```

### 4. status 값

```
등원예정 | 재원 | 실휴원 | 가휴원 | 퇴원
```

- 휴원 선택 시 `pause_start_date`, `pause_end_date` 입력창 표시
- 휴원 기간 31일 초과 시 경고: `window.checkDurationLimit()`

### 5. class_type (수업종류)

```
정규 | 특강 | 내신
```

- `특강` 선택 시 `special_start_date`, `special_end_date` 입력창 표시 (등원일 숨김)

### 6. 인증 (이중 보안)

**클라이언트 (app.js):**
```js
const allowedDomain = email.endsWith('@gw.impact7.kr') || email.endsWith('@impact7.kr');
if (!user.emailVerified || !allowedDomain) { /* 로그아웃 처리 */ }
```

**서버 (firestore.rules):**
```
function isAuthorized() {
    return request.auth != null
        && request.auth.token.email_verified == true
        && (request.auth.token.email.matches('.*@gw\\.impact7\\.kr')
            || request.auth.token.email.matches('.*@impact7\\.kr'));
}
```

- `auth.js`의 `hd` 파라미터는 단일 도메인만 지원하므로 주석 처리됨
- 실제 보안은 app.js + firestore.rules 이중 검증

### 7. history_logs 필수 기록

모든 Firestore 쓰기 시 반드시 함께 기록:

```js
await addDoc(collection(db, 'history_logs'), {
    doc_id:          docId,
    change_type:     'ENROLL' | 'UPDATE' | 'WITHDRAW',
    before:          '이전값',
    after:           '변경값',
    google_login_id: currentUser?.email || 'system',
    timestamp:       serverTimestamp(),
});
```

### 8. AND 복합 필터 (사이드바)

```js
let activeFilters = { level: null, branch: null, day: null, status: null, class_type: null };
```

- 각 카테고리(학부, 소속, 요일, 상태, 수업종류) 독립 선택
- 같은 타입 재클릭 → 해제 (토글)
- 다른 타입 조합 → AND 결합 (예: 2단지 + 정규 + 수요일)
- 필터 칩(chips)으로 활성 필터 표시 + 전체 해제 버튼

### 9. XSS 방지

```js
const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
};
```

- 사용자 입력(메모, 이력)을 innerHTML에 삽입할 때 반드시 `esc()` 사용

---

## Firestore 컬렉션 스키마

### students (컬렉션)

```
{
  name, level, school, grade,
  student_phone, parent_phone_1, parent_phone_2,
  branch, level_code, level_symbol,
  day: array,       // ["월", "수"]
  class_type,       // 정규 | 특강 | 내신
  special_start_date, special_end_date,  // 특강일 때만
  start_date,       // 등원일 (정규/내신)
  status,           // 등원예정 | 재원 | 실휴원 | 가휴원 | 퇴원
  pause_start_date, pause_end_date,      // 휴원일 때만
}
```

### students/{docId}/memos (서브컬렉션)

```
{ text: string, created_at: Timestamp, author: string }
```

### history_logs (컬렉션)

```
{ doc_id, change_type, before, after, google_login_id, timestamp }
```

**복합 인덱스** (firestore.indexes.json에 정의):
- `doc_id ASC` + `timestamp DESC` → 학생별 이력 조회

---

## 주요 전역 함수 (app.js)

| 함수 | 설명 |
|---|---|
| `window.handleLogin()` | Google 로그인/로그아웃 토글 |
| `window.selectStudent(id, data, el)` | 학생 선택 → 프로필 + 메모 + 이력 로드 |
| `window.showNewStudentForm()` | 신규 등록 폼 표시 |
| `window.showEditForm()` | 정보 수정 폼 표시 (pre-fill) |
| `window.hideForm()` | 폼 닫고 상세 뷰로 복귀 |
| `window.submitNewStudent()` | 등록/수정 저장 → Firestore + history_logs |
| `window.handleStatusChange(val)` | 상태 변경 시 휴원 기간 입력창 토글 |
| `window.handleClassTypeChange(val)` | 수업종류 변경 시 날짜 입력창 토글 |
| `window.handleLevelSymbolChange(val)` | 레벨기호 입력 시 소속 미리보기 |
| `window.checkDurationLimit()` | 휴원 기간 31일 초과 확인 |
| `window.openMemoModal(context)` | 메모 모달 열기 ('view' \| 'form') |
| `window.closeMemoModal(e)` | 메모 모달 닫기 |
| `window.saveMemoFromModal()` | 모달에서 메모 저장 → Firestore |
| `window.deleteMemo(studentId, memoId)` | 메모 삭제 (확인 다이얼로그) |
| `window.toggleMemo(memoId)` | 메모 카드 펼치기/접기 |
| `window.clearFilters()` | 모든 필터 해제 |
| `window.refreshStudents()` | 학생 목록 전체 재로드 |

---

## 완료된 기능 목록

- [x] Firebase Auth (Google 로그인) + email_verified 검증
- [x] 이중 도메인 보안 (`gw.impact7.kr` + `impact7.kr`) — 클라이언트 + 서버 규칙
- [x] Firestore 연결 및 학생 목록 로드 + 검색
- [x] AND 복합 필터 (학부/소속/요일/상태/수업종류) + 필터 칩 + 전체 해제
- [x] 학생 상세 프로필 뷰 + 탭 (기본정보 / 수업이력)
- [x] 수업이력 탭 — history_logs 쿼리 + 복합 인덱스
- [x] 신규 등록 폼 + 정보 수정 폼 (Firestore 저장, history_logs 기록)
- [x] 실휴원 / 가휴원 상태 + 휴원 기간 날짜 입력 + 31일 초과 경고
- [x] 수업종류(정규/특강/내신) + 특강 기간 날짜 입력
- [x] 일요일 포함 월~일 요일 선택
- [x] 학교+학부+학년 축약 표시 (`진명여고2`)
- [x] 소속 자동 파생 (레벨기호 첫 자리 기반)
- [x] 날짜 포맷 통일 (YYYY-MM-DD)
- [x] 메모 모달 (추가, 접기/펼치기, 삭제, Firestore 서브컬렉션)
- [x] XSS 방지 (`esc()` 헬퍼)
- [x] Firestore 보안 규칙 배포 완료 (email_verified + 도메인 regex)
- [x] Firestore 복합 인덱스 배포 완료
- [x] 브라우저 UI 기반 CSV 데이터 전체 대량 Import 및 Export 기능 완료 (batch write, history_logs 자동 기록)

---

## 다음 작업 권장 목록

### 1순위: 추가 개선 (검색 및 UI)
- **학생 초성 검색 지원**: 학생 검색창에서 초성(ㄱㄴㄷ)만으로도 이름/학교 등을 검색할 수 있도록 로직 개선
- **출결 관리 시스템 기반 작업**: 날짜별 출결을 저장할 수 있는 서브컬렉션 생성 및 뷰 디자인
- **반별/소속별 학생 그룹 뷰 구현**


---

## 주의사항

- `student_id` 필드는 Firestore에서 완전 삭제됨. 코드에서 참조하지 말 것
- `day` 필드는 반드시 배열 또는 `normalizeDays()`로 처리할 것
- 모든 쓰기 작업 후 `history_logs` 기록 필수
- `branch` 필드는 `branchFromSymbol(level_symbol)`로 자동 생성, 폼에 선택 UI 없음
- `.env` 파일은 git에 포함되지 않음. 새 환경 세팅 시 직접 생성 필요
- 사용자 입력을 innerHTML에 넣을 때 반드시 `esc()` 함수 사용 (XSS 방지)
- `apps/`, `core/`, `userlog.js` 등은 레거시 파일 — 현재 미사용이나 삭제는 보류
