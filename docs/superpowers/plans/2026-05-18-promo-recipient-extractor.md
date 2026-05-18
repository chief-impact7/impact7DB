# 홍보문자 수신자 추출 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 좌측 사이드바의 "홍보 추출" 진입점을 통해 상태·학부×학년 그리드 필터로 수신자를 선별하고, 비원생의 누적 grade를 read-time으로 정규화해 "현재 실제 학년"으로 보여주며, 선택 행을 클립보드 복사하거나 Google Sheets로 내보낸다.

**Architecture:** 신규 모듈 3개 분리 — `promo-extractor-core.js`(순수 함수, 테스트 대상), `promo-extractor.js`(DOM/모달/store 연결), `sheet-export.js`(Google Sheets API 호출 헬퍼). 기존 `app.js`는 무수정(AGENTS.md 규칙 1·3 준수). 데이터 변경 없음.

**Tech Stack:** Vanilla JS (ES modules) + Vite + Firebase Auth (OAuth 토큰 재사용) + Google Sheets API v4 + node:test (Node 22 내장)

**Spec:** `docs/superpowers/specs/2026-05-18-promo-recipient-extractor-design.md`

---

## File Structure

| 파일 | 역할 |
|---|---|
| `promo-extractor-core.js` (신규) | 순수 함수: `normalizeRealLevelGrade`, `pickPrimaryPhone`, `gridKeyFor`, `mergeByPhone`. DOM·store·Firebase 미사용 → 단위 테스트 가능 |
| `promo-extractor.js` (신규) | 모달 진입점 `openPromoExtractModal`, 필터 상태 관리, 테이블 렌더, 액션 핸들러. store에서 `allStudents` 읽기 전용 |
| `sheet-export.js` (신규) | `createGoogleSheet(title, headers, rows)` 헬퍼. `auth.js`의 `getGoogleAccessToken` 사용 |
| `index.html` (수정) | 사이드바 Registration 버튼 아래 "홍보 추출" 버튼 추가, 모달 마크업 body 끝에 추가 |
| `style.css` (수정) | 모달/그리드/테이블 스타일 추가 |
| `tests/promo-extractor-core.test.js` (신규) | node:test로 순수 함수 검증 |
| `package.json` (수정) | `test` script 추가 |

---

## Task 1: 테스트 환경 셋업

**Files:**
- Modify: `package.json`
- Create: `tests/.gitkeep`

- [ ] **Step 1: `package.json`에 test script 추가**

기존 `scripts` 블록에 한 줄 추가:

```json
"scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "node --test tests/*.test.js",
    "import": "node --env-file=.env import-students.js",
    ...
}
```

- [ ] **Step 2: `tests/` 디렉토리 생성**

```bash
mkdir -p tests && touch tests/.gitkeep
```

- [ ] **Step 3: 동작 확인 — 빈 테스트 디렉토리에서 실행**

```bash
npm test
```

Expected: `node:test` 실행, 0 tests passed (또는 "no test files" 메시지). 의존성 추가 없음 확인.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/.gitkeep
git commit -m "홍보 추출 — 테스트 환경 셋업(node:test, tests/ 디렉토리)"
```

---

## Task 2: 순수 함수 `normalizeRealLevelGrade` (TDD)

**Files:**
- Create: `tests/promo-extractor-core.test.js`
- Create: `promo-extractor-core.js`

- [ ] **Step 1: 실패 테스트 작성**

`tests/promo-extractor-core.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRealLevelGrade } from '../promo-extractor-core.js';

test('정상 데이터: 초3 → 초3', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: 3 }),
        { level: '초등', grade: 3, graduated: false }
    );
});

test('정상 데이터 경계: 초6 → 초6', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: 6 }),
        { level: '초등', grade: 6, graduated: false }
    );
});

test('정상 데이터 경계: 중3 → 중3', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '중등', grade: 3 }),
        { level: '중등', grade: 3, graduated: false }
    );
});

test('누적 데이터: 초11 → 고2 (사용자 사례)', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: 11 }),
        { level: '고등', grade: 2, graduated: false }
    );
});

test('누적 데이터: 초7 → 중1', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: 7 }),
        { level: '중등', grade: 1, graduated: false }
    );
});

test('누적 데이터: 중5 → 고2 (base=6, 6+5=11)', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '중등', grade: 5 }),
        { level: '고등', grade: 2, graduated: false }
    );
});

test('졸업 진입: 고4 → 졸업+1', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '고등', grade: 4 }),
        { level: '졸업', grade: 1, graduated: true }
    );
});

test('졸업 누적: 고6 → 졸업+3', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '고등', grade: 6 }),
        { level: '졸업', grade: 3, graduated: true }
    );
});

test('grade 문자열 처리: "3" → 3', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: '3' }),
        { level: '초등', grade: 3, graduated: false }
    );
});

test('grade 없음(0/null): 학부만 반환', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '중등', grade: null }),
        { level: '중등', grade: 0, graduated: false }
    );
});

test('level 없음: 초등으로 가정', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: null, grade: 5 }),
        { level: '초등', grade: 5, graduated: false }
    );
});
```

- [ ] **Step 2: 실패 확인**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../promo-extractor-core.js'`

- [ ] **Step 3: 최소 구현**

`promo-extractor-core.js`:

```javascript
const LEVEL_CUMULATIVE_START = { '초등': 0, '중등': 6, '고등': 9 };

export function normalizeRealLevelGrade(s) {
    const base = LEVEL_CUMULATIVE_START[s.level] ?? 0;
    const cumulative = base + (parseInt(s.grade, 10) || 0);

    if (cumulative <= 0)  return { level: s.level || '초등', grade: 0, graduated: false };
    if (cumulative <= 6)  return { level: '초등', grade: cumulative,        graduated: false };
    if (cumulative <= 9)  return { level: '중등', grade: cumulative - 6,    graduated: false };
    if (cumulative <= 12) return { level: '고등', grade: cumulative - 9,    graduated: false };
    return { level: '졸업', grade: cumulative - 12, graduated: true };
}
```

- [ ] **Step 4: 통과 확인**

```bash
npm test
```

Expected: PASS — 11 tests pass

- [ ] **Step 5: Commit**

```bash
git add promo-extractor-core.js tests/promo-extractor-core.test.js
git commit -m "홍보 추출 — normalizeRealLevelGrade 순수 함수 + TDD"
```

---

## Task 3: 순수 함수 `pickPrimaryPhone` (TDD)

**Files:**
- Modify: `tests/promo-extractor-core.test.js`
- Modify: `promo-extractor-core.js`

- [ ] **Step 1: 실패 테스트 추가**

`tests/promo-extractor-core.test.js` 끝에 추가:

```javascript
import { pickPrimaryPhone } from '../promo-extractor-core.js';

test('학부모₁ 우선', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: '010-1', student_phone: '010-2', parent_phone_2: '010-3' }),
        '010-1'
    );
});

test('학부모₁ 없으면 학생본인', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: '', student_phone: '010-2', parent_phone_2: '010-3' }),
        '010-2'
    );
});

test('학부모₁·본인 없으면 학부모₂', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: null, student_phone: '', parent_phone_2: '010-3' }),
        '010-3'
    );
});

test('모두 없으면 null', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: '', student_phone: null, parent_phone_2: undefined }),
        null
    );
});

test('공백만 있는 번호는 무시', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: '   ', student_phone: '010-9' }),
        '010-9'
    );
});
```

- [ ] **Step 2: 실패 확인**

```bash
npm test
```

Expected: FAIL — `pickPrimaryPhone` 미정의

- [ ] **Step 3: 구현 추가**

`promo-extractor-core.js` 끝에 추가:

```javascript
export function pickPrimaryPhone(s) {
    const candidates = [s.parent_phone_1, s.student_phone, s.parent_phone_2];
    for (const phone of candidates) {
        if (phone && String(phone).trim()) return String(phone).trim();
    }
    return null;
}
```

- [ ] **Step 4: 통과 확인**

```bash
npm test
```

Expected: PASS — 16 tests pass (누적)

- [ ] **Step 5: Commit**

```bash
git add promo-extractor-core.js tests/promo-extractor-core.test.js
git commit -m "홍보 추출 — pickPrimaryPhone 우선순위 선택 함수"
```

---

## Task 4: 순수 함수 `gridKeyFor` 매칭 키 (TDD)

**Files:**
- Modify: `tests/promo-extractor-core.test.js`
- Modify: `promo-extractor-core.js`

매칭 알고리즘: 그리드에서 체크된 키 집합(예: `{"중3","고1","졸업"}`)에 학생의 정규화 키가 포함되는지 검사. 졸업 학생은 grade와 무관하게 `"졸업"` 단일 키.

- [ ] **Step 1: 실패 테스트 추가**

`tests/promo-extractor-core.test.js` 끝에 추가:

```javascript
import { gridKeyFor } from '../promo-extractor-core.js';

test('일반 학생 키: 학부+학년', () => {
    assert.equal(
        gridKeyFor({ level: '초등', grade: 3, graduated: false }),
        '초등3'
    );
    assert.equal(
        gridKeyFor({ level: '고등', grade: 1, graduated: false }),
        '고등1'
    );
});

test('졸업 학생 키: grade 무관 "졸업"', () => {
    assert.equal(
        gridKeyFor({ level: '졸업', grade: 1, graduated: true }),
        '졸업'
    );
    assert.equal(
        gridKeyFor({ level: '졸업', grade: 5, graduated: true }),
        '졸업'
    );
});
```

- [ ] **Step 2: 실패 확인**

```bash
npm test
```

Expected: FAIL — `gridKeyFor` 미정의

- [ ] **Step 3: 구현 추가**

`promo-extractor-core.js` 끝에 추가:

```javascript
export function gridKeyFor(normalized) {
    if (normalized.graduated) return '졸업';
    return `${normalized.level}${normalized.grade}`;
}
```

- [ ] **Step 4: 통과 확인**

```bash
npm test
```

Expected: PASS — 20 tests pass (누적)

- [ ] **Step 5: Commit**

```bash
git add promo-extractor-core.js tests/promo-extractor-core.test.js
git commit -m "홍보 추출 — gridKeyFor 매칭 키 함수"
```

---

## Task 5: 순수 함수 `mergeByPhone` 중복 병합 (TDD)

**Files:**
- Modify: `tests/promo-extractor-core.test.js`
- Modify: `promo-extractor-core.js`

대표번호가 같은 행(형제 등)을 하나로 합치고, 합쳐진 행의 `mergedNames`에 모든 이름을 보존.

- [ ] **Step 1: 실패 테스트 추가**

```javascript
import { mergeByPhone } from '../promo-extractor-core.js';

test('빈 배열은 빈 배열', () => {
    assert.deepEqual(mergeByPhone([]), []);
});

test('중복 없으면 그대로', () => {
    const rows = [
        { name: '김지유', phone: '010-1', level: '초등', grade: 3 },
        { name: '이서연', phone: '010-2', level: '초등', grade: 4 },
    ];
    const merged = mergeByPhone(rows);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0].mergedNames, ['김지유']);
});

test('같은 번호 2건 → 1건 병합, 이름 합치기', () => {
    const rows = [
        { name: '김지유', phone: '010-1', level: '초등', grade: 3 },
        { name: '김지윤', phone: '010-1', level: '초등', grade: 5 },
    ];
    const merged = mergeByPhone(rows);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].phone, '010-1');
    assert.deepEqual(merged[0].mergedNames, ['김지유', '김지윤']);
});

test('번호 null인 행은 병합 대상에서 제외(그대로 보존)', () => {
    const rows = [
        { name: '김지유', phone: null, level: '초등', grade: 3 },
        { name: '이서연', phone: null, level: '초등', grade: 4 },
    ];
    const merged = mergeByPhone(rows);
    assert.equal(merged.length, 2); // null은 합치지 않음
});
```

- [ ] **Step 2: 실패 확인**

```bash
npm test
```

Expected: FAIL — `mergeByPhone` 미정의

- [ ] **Step 3: 구현 추가**

```javascript
export function mergeByPhone(rows) {
    const byPhone = new Map();
    const result = [];
    for (const row of rows) {
        if (!row.phone) {
            result.push({ ...row, mergedNames: [row.name] });
            continue;
        }
        if (byPhone.has(row.phone)) {
            byPhone.get(row.phone).mergedNames.push(row.name);
        } else {
            const merged = { ...row, mergedNames: [row.name] };
            byPhone.set(row.phone, merged);
            result.push(merged);
        }
    }
    return result;
}
```

- [ ] **Step 4: 통과 확인**

```bash
npm test
```

Expected: PASS — 24 tests pass (누적)

- [ ] **Step 5: Commit**

```bash
git add promo-extractor-core.js tests/promo-extractor-core.test.js
git commit -m "홍보 추출 — mergeByPhone 중복 전화 병합 함수"
```

---

## Task 6: `sheet-export.js` 헬퍼

**Files:**
- Create: `sheet-export.js`

기존 `app.js:3046-3138`의 시트 생성 로직을 일반화한 헬퍼. `app.js`는 무수정.

- [ ] **Step 1: `sheet-export.js` 작성**

```javascript
/**
 * sheet-export.js — Google Sheets API 호출 헬퍼
 *
 * 사용 예:
 *   await createGoogleSheet('내보내기_2026-05-18',
 *     ['이름', '학년', '전화'],
 *     [['김지유', '초3', '010-1'], ['이서연', '초4', '010-2']]);
 *
 * OAuth 토큰은 auth.js의 getGoogleAccessToken에서 가져온다.
 * 토큰 없으면 alert 후 null 반환.
 */
import { getGoogleAccessToken } from './auth.js';

export async function createGoogleSheet(title, headers, rows) {
    const token = getGoogleAccessToken();
    if (!token) {
        alert('구글 드라이브 접근 권한이 필요합니다.\n로그아웃 후 다시 로그인해주세요.');
        return null;
    }

    const headerRow = {
        values: headers.map(h => ({
            userEnteredValue: { stringValue: h },
            userEnteredFormat: {
                textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
                backgroundColorStyle: { rgbColor: { red: 0.263, green: 0.522, blue: 0.957 } }
            }
        }))
    };
    const bodyRows = rows.map(row => ({
        values: row.map(cell => ({ userEnteredValue: { stringValue: String(cell ?? '') } }))
    }));

    try {
        const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                properties: { title },
                sheets: [{
                    properties: { title: '데이터', gridProperties: { frozenRowCount: 1 } },
                    data: [{ startRow: 0, startColumn: 0, rowData: [headerRow, ...bodyRows] }]
                }]
            })
        });
        if (!createResp.ok) throw new Error(await createResp.text());
        const created = await createResp.json();
        const sid = created.sheets[0].properties.sheetId;

        const totalRows = rows.length + 1;
        const fmtResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${created.spreadsheetId}:batchUpdate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [
                { setBasicFilter: { filter: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: headers.length } } } },
                { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: headers.length } } }
            ]})
        });
        if (!fmtResp.ok) console.warn('[sheet-export] 서식 설정 실패:', await fmtResp.text());

        window.open(created.spreadsheetUrl, '_blank');
        return created.spreadsheetUrl;
    } catch (e) {
        alert('시트 내보내기 실패: ' + e.message + '\n\n로그아웃 후 다시 로그인하면 해결될 수 있습니다.');
        return null;
    }
}
```

- [ ] **Step 2: 빌드 통과 확인**

```bash
npm run build
```

Expected: 빌드 성공, `sheet-export.js`가 번들에 포함되지 않음(아직 import하는 곳 없음 — 그래도 syntax error 시 빌드 실패하므로 검증됨)

- [ ] **Step 3: Commit**

```bash
git add sheet-export.js
git commit -m "홍보 추출 — sheet-export.js 헬퍼(기존 handleSheetExport 로직 일반화)"
```

---

## Task 7: 사이드바 버튼 + 모달 마크업

**Files:**
- Modify: `index.html` (line 43~47 근처에 버튼, body 끝 모달 영역에 모달 추가)

- [ ] **Step 1: 사이드바 버튼 추가**

`index.html`에서 Registration 버튼(`<button class="compose-btn" onclick="window.showNewStudentForm()">`) 직후에 추가. 기존 코드:

```html
            <button class="compose-btn" onclick="window.showNewStudentForm()">
                <span class="material-symbols-outlined">person_add</span>
                Registration
            </button>

            <!-- L1: All Students (필터 + L2 토글) -->
```

변경 후:

```html
            <button class="compose-btn" onclick="window.showNewStudentForm()">
                <span class="material-symbols-outlined">person_add</span>
                Registration
            </button>

            <button class="compose-btn promo-extract-btn" onclick="window.openPromoExtractModal()">
                <span class="material-symbols-outlined">campaign</span>
                홍보 추출
            </button>

            <!-- L1: All Students (필터 + L2 토글) -->
```

- [ ] **Step 2: 모달 마크업 추가**

`index.html`의 다른 modal-overlay 패턴을 따라, `</body>` 직전(또는 마지막 modal 다음)에 추가:

```html
    <!-- 홍보 추출 모달 -->
    <div id="promo-extract-modal" class="modal-overlay" onclick="window.closePromoExtractModal(event)" style="display:none;">
        <div class="modal-content promo-extract-modal-content" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h3 style="margin:0;font-size:16px;">홍보 수신자 추출</h3>
                <button class="btn-icon" onclick="window.closePromoExtractModal()" aria-label="닫기">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>

            <div class="modal-body" style="padding:16px 20px;">
                <!-- 상태 필터 -->
                <div class="promo-filter-row">
                    <label class="promo-filter-label">상태</label>
                    <div class="promo-status-chips" id="promo-status-chips">
                        <button class="promo-chip" data-status="all">All</button>
                        <button class="promo-chip active" data-status="active">재원</button>
                        <button class="promo-chip" data-status="past">비원</button>
                    </div>
                </div>

                <!-- 학부×학년 그리드 -->
                <div class="promo-filter-row">
                    <label class="promo-filter-label">학부×학년</label>
                    <table class="promo-grid">
                        <thead>
                            <tr>
                                <th></th>
                                <th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th>
                                <th class="promo-grid-toggle-col">
                                    <input type="checkbox" id="promo-grid-all" checked aria-label="전체 토글">
                                </th>
                            </tr>
                        </thead>
                        <tbody id="promo-grid-body">
                            <!-- 동적 생성 -->
                        </tbody>
                    </table>
                </div>

                <div class="promo-filter-row">
                    <label class="promo-checkbox-label">
                        <input type="checkbox" id="promo-merge-phones" checked>
                        동일 번호 자동 병합
                    </label>
                </div>

                <!-- 카운트 + 액션 -->
                <div class="promo-summary" id="promo-summary">조회 중…</div>

                <div class="promo-actions">
                    <label class="promo-checkbox-label">
                        <input type="checkbox" id="promo-select-all">
                        전체 선택
                    </label>
                    <div class="promo-action-buttons">
                        <button class="btn-primary" id="promo-copy-btn">선택 복사</button>
                        <button class="btn-secondary" id="promo-sheet-btn">구글시트 다운로드</button>
                    </div>
                </div>

                <!-- 결과 테이블 -->
                <div class="promo-table-wrap">
                    <table class="promo-table">
                        <thead>
                            <tr>
                                <th></th>
                                <th>이름</th>
                                <th>학부</th>
                                <th>학년</th>
                                <th>학교</th>
                                <th>대표번호</th>
                                <th>상태</th>
                            </tr>
                        </thead>
                        <tbody id="promo-table-body">
                            <!-- 동적 생성 -->
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
```

- [ ] **Step 3: 빌드 통과 확인**

```bash
npm run build
```

Expected: 빌드 성공. HTML 구조 깨지지 않음.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "홍보 추출 — 사이드바 버튼 + 모달 마크업"
```

---

## Task 8: 모달 CSS 스타일

**Files:**
- Modify: `style.css`

- [ ] **Step 1: 스타일 추가**

`style.css` 끝에 추가:

```css
/* ─── 홍보 추출 모달 ─────────────────────────────── */
.promo-extract-btn {
    background: var(--bg-elev, #f5f5f5);
    color: var(--text-pri, #1a1a1a);
}
.promo-extract-btn:hover {
    background: var(--bg-hover, #e8e8e8);
}

.promo-extract-modal-content {
    max-width: 920px;
    width: 92vw;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
}

.promo-extract-modal-content .modal-body {
    overflow-y: auto;
    flex: 1;
}

.promo-filter-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 14px;
}

.promo-filter-label {
    width: 80px;
    flex-shrink: 0;
    font-weight: 600;
    color: var(--text-pri);
    padding-top: 6px;
}

.promo-status-chips {
    display: flex;
    gap: 6px;
}

.promo-chip {
    padding: 6px 14px;
    border: 1px solid var(--border, #ddd);
    background: var(--bg-card, #fff);
    border-radius: 16px;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
}
.promo-chip:hover {
    background: var(--bg-hover, #f0f0f0);
}
.promo-chip.active {
    background: var(--primary, #4285f4);
    color: #fff;
    border-color: var(--primary, #4285f4);
}

.promo-grid {
    border-collapse: collapse;
    font-size: 13px;
}
.promo-grid th, .promo-grid td {
    padding: 6px 10px;
    text-align: center;
    border: 1px solid var(--border, #eee);
}
.promo-grid th:first-child, .promo-grid td:first-child {
    text-align: left;
    font-weight: 600;
    background: var(--bg-elev, #fafafa);
}
.promo-grid-toggle-col {
    background: var(--bg-elev, #fafafa);
}
.promo-grid td.disabled {
    background: var(--bg-disabled, #f5f5f5);
    color: var(--text-sec, #999);
}

.promo-checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    cursor: pointer;
}

.promo-summary {
    padding: 8px 12px;
    background: var(--bg-elev, #f5f7fa);
    border-radius: 6px;
    font-size: 13px;
    margin: 12px 0;
    color: var(--text-sec, #555);
}

.promo-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 12px 0;
}

.promo-action-buttons {
    display: flex;
    gap: 8px;
}

.promo-table-wrap {
    max-height: 360px;
    overflow-y: auto;
    border: 1px solid var(--border, #eee);
    border-radius: 6px;
}

.promo-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}
.promo-table th {
    position: sticky;
    top: 0;
    background: var(--bg-elev, #fafafa);
    padding: 8px 10px;
    text-align: left;
    border-bottom: 1px solid var(--border, #eee);
    font-weight: 600;
    z-index: 1;
}
.promo-table td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border, #f0f0f0);
}
.promo-table tbody tr:hover {
    background: var(--bg-hover, #f8f9fb);
}
.promo-table .promo-empty {
    text-align: center;
    padding: 32px;
    color: var(--text-sec, #999);
}
```

- [ ] **Step 2: 빌드 통과 확인**

```bash
npm run build
```

Expected: 빌드 성공.

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "홍보 추출 — 모달/그리드/테이블 CSS"
```

---

## Task 9: `promo-extractor.js` — 모달 로직 (필터 + 렌더링)

**Files:**
- Create: `promo-extractor.js`
- Modify: `index.html` (모듈 import)

- [ ] **Step 1: `promo-extractor.js` 작성**

```javascript
/**
 * promo-extractor.js — 홍보 수신자 추출 모달
 *
 * 좌측 사이드바 "홍보 추출" 버튼에서 진입.
 * 상태 + 학부×학년 그리드 필터로 학생을 추려 대표번호 추출.
 * 비원생은 normalizeRealLevelGrade로 현재 실제 학년으로 변환.
 */
import { state } from './store.js';
import {
    normalizeRealLevelGrade,
    pickPrimaryPhone,
    gridKeyFor,
    mergeByPhone,
} from './promo-extractor-core.js';
import { createGoogleSheet } from './sheet-export.js';

const PAST_STATUSES = new Set(['퇴원', '종강']);
const ACTIVE_STATUSES = new Set(['등원예정', '재원', '실휴원', '가휴원']);

// 그리드 정의
const GRID_ROWS = [
    { level: '초등', grades: [1, 2, 3, 4, 5, 6] },
    { level: '중등', grades: [1, 2, 3] },
    { level: '고등', grades: [1, 2, 3] },
    { level: '졸업', grades: null }, // 단일 셀
];

// 모달 상태
let currentStatusFilter = 'active'; // 'all' | 'active' | 'past'
let selectedGridKeys = new Set();   // 예: {'초등3','중등1','졸업'}
let mergePhones = true;
let lastRenderedRows = [];          // 마지막 렌더된 행(체크박스 토글용)

// ─── 진입점 ─────────────────────────────────────────────────────────
window.openPromoExtractModal = function () {
    const modal = document.getElementById('promo-extract-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    initModal();
};

window.closePromoExtractModal = function () {
    // overlay 클릭 / 닫기 버튼 둘 다 단순 닫기.
    // (modal-content에 event.stopPropagation()이 있어 내부 클릭은 여기로 안 옴)
    document.getElementById('promo-extract-modal').style.display = 'none';
};

// ─── 초기화 ─────────────────────────────────────────────────────────
function initModal() {
    buildGrid();
    bindFilterEvents();
    bindActionEvents();
    refresh();
}

function buildGrid() {
    const tbody = document.getElementById('promo-grid-body');
    tbody.innerHTML = '';

    for (const row of GRID_ROWS) {
        const tr = document.createElement('tr');
        const labelTd = document.createElement('td');
        labelTd.textContent = row.level;
        tr.appendChild(labelTd);

        if (row.grades === null) {
            // 졸업: 1~6 셀 자리에 colspan, 단일 체크박스
            const cell = document.createElement('td');
            cell.colSpan = 6;
            cell.innerHTML = `<input type="checkbox" class="promo-grid-cell" data-key="졸업" checked>`;
            tr.appendChild(cell);
        } else {
            for (let g = 1; g <= 6; g++) {
                const td = document.createElement('td');
                if (row.grades.includes(g)) {
                    td.innerHTML = `<input type="checkbox" class="promo-grid-cell" data-key="${row.level}${g}" checked>`;
                } else {
                    td.classList.add('disabled');
                    td.textContent = '–';
                }
                tr.appendChild(td);
            }
        }

        // 행 전체 토글
        const toggleTd = document.createElement('td');
        toggleTd.classList.add('promo-grid-toggle-col');
        toggleTd.innerHTML = `<input type="checkbox" class="promo-grid-row-toggle" data-level="${row.level}" checked>`;
        tr.appendChild(toggleTd);

        tbody.appendChild(tr);
    }

    // 초기 선택 키 = 모든 셀
    selectedGridKeys = new Set(
        [...tbody.querySelectorAll('.promo-grid-cell')].map(el => el.dataset.key)
    );
}

function bindFilterEvents() {
    // 상태 chips
    document.querySelectorAll('#promo-status-chips .promo-chip').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#promo-status-chips .promo-chip').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentStatusFilter = btn.dataset.status;
            refresh();
        };
    });

    // 그리드 셀
    document.querySelectorAll('.promo-grid-cell').forEach(cb => {
        cb.onchange = () => {
            const key = cb.dataset.key;
            if (cb.checked) selectedGridKeys.add(key);
            else selectedGridKeys.delete(key);
            syncRowToggles();
            syncGridAllToggle();
            refresh();
        };
    });

    // 행 전체 토글
    document.querySelectorAll('.promo-grid-row-toggle').forEach(cb => {
        cb.onchange = () => {
            const level = cb.dataset.level;
            const cells = document.querySelectorAll(`.promo-grid-cell[data-key^="${level}"]`);
            cells.forEach(cell => {
                cell.checked = cb.checked;
                const key = cell.dataset.key;
                if (cb.checked) selectedGridKeys.add(key);
                else selectedGridKeys.delete(key);
            });
            syncGridAllToggle();
            refresh();
        };
    });

    // 전체 토글
    document.getElementById('promo-grid-all').onchange = (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.promo-grid-cell').forEach(cell => {
            cell.checked = checked;
            const key = cell.dataset.key;
            if (checked) selectedGridKeys.add(key);
            else selectedGridKeys.delete(key);
        });
        document.querySelectorAll('.promo-grid-row-toggle').forEach(t => t.checked = checked);
        refresh();
    };

    // 병합 토글
    document.getElementById('promo-merge-phones').onchange = (e) => {
        mergePhones = e.target.checked;
        refresh();
    };
}

function syncRowToggles() {
    for (const row of GRID_ROWS) {
        if (row.grades === null) continue;
        const cells = document.querySelectorAll(`.promo-grid-cell[data-key^="${row.level}"]`);
        const allChecked = [...cells].every(c => c.checked);
        const toggle = document.querySelector(`.promo-grid-row-toggle[data-level="${row.level}"]`);
        if (toggle) toggle.checked = allChecked;
    }
}

function syncGridAllToggle() {
    const allCells = document.querySelectorAll('.promo-grid-cell');
    const allChecked = [...allCells].every(c => c.checked);
    document.getElementById('promo-grid-all').checked = allChecked;
}

// ─── 필터링 ─────────────────────────────────────────────────────────
function buildRows() {
    const students = state.allStudents || [];

    // 1. 상태 필터
    const statusFiltered = students.filter(s => {
        if (currentStatusFilter === 'all')    return ACTIVE_STATUSES.has(s.status) || PAST_STATUSES.has(s.status);
        if (currentStatusFilter === 'active') return ACTIVE_STATUSES.has(s.status);
        if (currentStatusFilter === 'past')   return PAST_STATUSES.has(s.status);
        return false;
    });

    // 2. 정규화 + 그리드 매칭 + 전화 추출
    let phoneMissing = 0;
    const rows = [];
    for (const s of statusFiltered) {
        const norm = normalizeRealLevelGrade(s);
        const key = gridKeyFor(norm);
        if (!selectedGridKeys.has(key)) continue;

        const phone = pickPrimaryPhone(s);
        if (!phone) { phoneMissing++; continue; }

        rows.push({
            id: s.id,
            name: s.name || '',
            level: norm.level,
            grade: norm.graduated ? `졸업+${norm.grade}` : String(norm.grade),
            school: s.school || '',
            phone,
            status: s.status || '',
        });
    }

    // 3. 중복 병합
    let mergedCount = 0;
    let finalRows = rows;
    if (mergePhones) {
        const before = rows.length;
        finalRows = mergeByPhone(rows);
        mergedCount = before - finalRows.length;
    } else {
        finalRows = rows.map(r => ({ ...r, mergedNames: [r.name] }));
    }

    return { rows: finalRows, phoneMissing, mergedCount };
}

// ─── 렌더링 ─────────────────────────────────────────────────────────
function refresh() {
    const { rows, phoneMissing, mergedCount } = buildRows();
    lastRenderedRows = rows;

    // 카운트
    const parts = [`매칭 ${rows.length}명`];
    if (phoneMissing > 0) parts.push(`전화 누락 ${phoneMissing}명 제외`);
    if (mergedCount > 0) parts.push(`중복 ${mergedCount}건 병합`);
    document.getElementById('promo-summary').textContent = parts.join(' · ');

    // 테이블
    const tbody = document.getElementById('promo-table-body');
    tbody.innerHTML = '';
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="promo-empty">조건에 맞는 학생이 없습니다</td></tr>`;
        document.getElementById('promo-select-all').checked = false;
        return;
    }

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const tr = document.createElement('tr');
        const displayName = r.mergedNames.length > 1 ? r.mergedNames.join(', ') : r.name;
        tr.innerHTML = `
            <td><input type="checkbox" class="promo-row-check" data-idx="${i}" checked></td>
            <td>${escapeHtml(displayName)}</td>
            <td>${escapeHtml(r.level)}</td>
            <td>${escapeHtml(r.grade)}</td>
            <td>${escapeHtml(r.school)}</td>
            <td>${escapeHtml(r.phone)}</td>
            <td>${escapeHtml(r.status)}</td>
        `;
        tbody.appendChild(tr);
    }
    document.getElementById('promo-select-all').checked = true;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ─── 액션 (Task 10·11에서 구현) ─────────────────────────────────────
function bindActionEvents() {
    document.getElementById('promo-select-all').onchange = (e) => {
        document.querySelectorAll('.promo-row-check').forEach(cb => cb.checked = e.target.checked);
    };
    document.getElementById('promo-copy-btn').onclick = handleCopy;
    document.getElementById('promo-sheet-btn').onclick = handleSheetExport;
}

function getCheckedRows() {
    const checked = [...document.querySelectorAll('.promo-row-check:checked')]
        .map(cb => parseInt(cb.dataset.idx, 10));
    return checked.map(idx => lastRenderedRows[idx]).filter(Boolean);
}

async function handleCopy() {
    // Task 10에서 구현
    alert('Task 10에서 구현 예정');
}

async function handleSheetExport() {
    // Task 11에서 구현
    alert('Task 11에서 구현 예정');
}
```

- [ ] **Step 2: `index.html`에 모듈 import 추가**

`index.html`의 기존 `<script type="module" src="app.js">` (또는 비슷한 위치) 근처에서 동일 패턴으로 한 줄 추가. 정확한 위치는 기존 app.js 모듈 로드 라인 뒤:

```bash
grep -n 'src="app.js"' /Users/jongsooyi/projects/impact7DB/index.html
```

찾은 라인 다음에 추가:

```html
    <script type="module" src="promo-extractor.js"></script>
```

- [ ] **Step 3: dev 서버에서 수동 검증**

```bash
npm run dev
```

브라우저에서 `http://localhost:5173` 열고:
1. 좌측 사이드바 상단에 "홍보 추출" 버튼 보임 확인
2. 클릭하면 모달 열림
3. 그리드 셀 체크/해제 시 카운트 변경
4. 상태 chips 전환 시 카운트 변경
5. 행 전체 토글, 전체 토글 동작
6. 동일 번호 자동 병합 토글 시 카운트 변경
7. 학생이 0명일 때 "조건에 맞는 학생이 없습니다" 표시
8. 비원 + 그리드 졸업만 체크 → 가상승급 결과 고3 초과 학생만 표시되는지 확인

Expected: 모든 항목 정상 동작. 복사/시트 버튼은 alert만 뜸 (Task 10·11에서 구현).

- [ ] **Step 4: Commit**

```bash
git add promo-extractor.js index.html
git commit -m "홍보 추출 — 모달 초기화·필터링·테이블 렌더 (복사/시트 액션은 stub)"
```

---

## Task 10: 선택 복사 액션

**Files:**
- Modify: `promo-extractor.js` (handleCopy 함수)

- [ ] **Step 1: `handleCopy` 구현**

`promo-extractor.js`의 기존 `handleCopy` 함수를 다음으로 교체:

```javascript
async function handleCopy() {
    const rows = getCheckedRows();
    if (rows.length === 0) {
        alert('선택된 행이 없습니다.');
        return;
    }
    const text = rows.map(r => r.phone).join(',');

    try {
        await navigator.clipboard.writeText(text);
        alert(`${rows.length}개 번호를 복사했습니다.`);
    } catch (e) {
        // fallback: textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            alert(`${rows.length}개 번호를 복사했습니다.`);
        } catch (fallbackErr) {
            alert('복사 실패: ' + fallbackErr.message);
        } finally {
            document.body.removeChild(ta);
        }
    }
}
```

- [ ] **Step 2: dev 서버에서 수동 검증**

```bash
npm run dev
```

1. 모달 열기, 몇 행만 체크
2. "선택 복사" 클릭 → "N개 번호를 복사했습니다" 알림
3. 메모장이나 SMS 도구에 붙여넣기 → 쉼표 구분 번호 확인
4. 선택 0개에서 클릭 → "선택된 행이 없습니다" 알림

Expected: 클립보드에 정확한 번호 문자열이 들어감.

- [ ] **Step 3: Commit**

```bash
git add promo-extractor.js
git commit -m "홍보 추출 — 선택 복사 액션 (Clipboard API + fallback)"
```

---

## Task 11: Google Sheets 다운로드 액션

**Files:**
- Modify: `promo-extractor.js` (handleSheetExport 함수)

- [ ] **Step 1: `handleSheetExport` 구현**

`promo-extractor.js`의 기존 `handleSheetExport` 함수를 다음으로 교체:

```javascript
async function handleSheetExport() {
    const rows = getCheckedRows();
    if (rows.length === 0) {
        alert('선택된 행이 없습니다.');
        return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const filterSummary = buildFilterSummary();
    const title = `홍보수신자_${today}${filterSummary ? '_' + filterSummary : ''}`;
    const headers = ['이름', '학부', '학년', '학교', '대표번호', '상태'];
    const sheetRows = rows.map(r => {
        const displayName = r.mergedNames.length > 1 ? r.mergedNames.join(', ') : r.name;
        return [displayName, r.level, r.grade, r.school, r.phone, r.status];
    });

    await createGoogleSheet(title, headers, sheetRows);
}

function buildFilterSummary() {
    const parts = [];
    if (currentStatusFilter === 'active') parts.push('재원');
    else if (currentStatusFilter === 'past') parts.push('비원');

    const keys = [...selectedGridKeys].sort();
    if (keys.length > 0 && keys.length < 13) parts.push(keys.join('·'));
    return parts.join('_');
}
```

- [ ] **Step 2: dev 서버에서 수동 검증**

```bash
npm run dev
```

1. Google 로그인 상태에서 모달 열기
2. 몇 행 체크 후 "구글시트 다운로드" 클릭
3. 새 탭에 시트 열리는지 확인
4. 헤더(이름/학부/학년/학교/대표번호/상태)가 굵게 표시
5. 필터/자동맞춤 적용 확인
6. 로그아웃 상태에서 클릭 → 권한 안내 알림

Expected: 시트 정상 생성·열림.

- [ ] **Step 3: Commit**

```bash
git add promo-extractor.js
git commit -m "홍보 추출 — 구글시트 다운로드 액션"
```

---

## Task 12: 통합 검증 + 배포

**Files:** 없음 (검증 + 배포만)

- [ ] **Step 1: 모든 테스트 통과 확인**

```bash
npm test
```

Expected: 24 tests pass.

- [ ] **Step 2: 빌드 통과 확인**

```bash
npm run build
```

Expected: 빌드 성공, syntax error 없음.

- [ ] **Step 3: dev 서버에서 시나리오 8개 모두 검증**

```bash
npm run dev
```

- [ ] 재원 + 그리드 {초3, 초4} → 초3·초4 학생만 표시
- [ ] 재원 + 그리드 {중3, 고1} → 중3·고1 학생만 표시 (학년 교차 조합)
- [ ] 비원 + 그리드 전체 → 정규화된 학년으로 표시
- [ ] 비원 + 그리드 졸업만 → 가상승급 결과 고3 초과 학생만 표시
- [ ] "초등 행 전체" 클릭 → 초1~6 동시 토글
- [ ] 동일 학부모₁ 번호 형제 → 병합 ON 시 1건, OFF 시 2건
- [ ] 전화 누락 학생 카운트에 반영
- [ ] 복사: SMS 도구 붙여넣기 검증
- [ ] 시트 다운로드: 헤더·필터·자동맞춤 확인
- [ ] 실제 데이터에서 "초등 11학년" 학생이 "고2"로 표시되는지 확인 (사용자 사례)

- [ ] **Step 4: simplify 실행 (AGENTS.md 규칙)**

```
/simplify
```

simplify 결과 검토 후 의미 있는 정리만 수용. 동작 변경 없음 확인.

- [ ] **Step 5: 푸시**

```bash
git push origin master
```

GitHub Actions가 자동으로 빌드 + Firebase Hosting 배포(약 1-2분). 배포 완료 후 운영 환경에서도 1회 빠른 회귀 확인.

---

## Out of Scope (확인용)

- `runPromotion` 자동승급 정책 변경
- 비원생 데이터 정상화 마이그레이션
- CSV/Excel 다운로드
- `system_config/academic_year` 메타 (사용자 확인으로 불필요해짐)
- `notification_history` 로깅
