# 홍보문자 수신자 추출 — 설계 문서

- **작성일**: 2026-05-18
- **대상 앱**: impact7DB
- **요지**: 좌측 사이드바에 "홍보 추출" 진입점을 추가하고, 상태·학부·학년 필터로 추려낸 학생들의 대표 전화번호를 추출한다. 비원생(퇴원/종강)의 학년·학부는 read-time 정규화로 "현재 시점의 실제 학년"으로 환산해서 표시한다.

## 1. 문제 정의

홍보문자(SMS) 발송을 위해 다음 조건으로 수신자를 선별할 필요가 있다.

- 상태: `재원`(등원예정/재원/실휴원/가휴원) · `비원`(퇴원/종강) · `All`
- 학부×학년: 그리드에서 셀 단위 다중선택. 초1~6, 중1~3, 고1~3, 졸업 (학년 교차 조합 자유 — 예: "중3 + 고1"만)

**핵심 난제**: 비원생도 매년 grade가 +1되는 외부 프로세스가 있지만 `level`은 갱신되지 않는다. 그래서 데이터에 `level='초등', grade=11`(=현실 학년 고2) 같은 비정상 누적값이 쌓여 있다. 추출 시 이 누적 grade를 정규화하여 "현재 실제 학부·학년"으로 표시해야 한다.

## 2. 설계 결정 요약

| 항목 | 결정 | 근거 |
|---|---|---|
| 진입점 | 좌측 사이드바 최상단 새 버튼 "홍보 추출" | 일상 접근 동선과 일치 |
| 출력 형식 | 화면 테이블 + 체크박스 + 선택 복사 + Google Sheets 다운로드 | 사용자 결정 (CSV/Excel은 생략) |
| 상태 그룹 | 재원=등원예정/재원/실휴원/가휴원, 비원=퇴원/종강 | 휴원생도 학원과 연결된 상태 |
| 필터 UI | 학부×학년 셀 단위 다중 체크 그리드 + 행/전체 토글 | "중3+고1" 같은 학년 교차 조합 정확히 지원 |
| 졸업 표현 | `level='졸업'`을 정규화 함수 결과로만 사용 (DB에는 저장 X) | 데이터 무결성 보존 |
| 대표 전화 | 학부모₁ → 학생본인 → 학부모₂ 우선 첫 존재값 | 사용자 결정 |
| 가상승급 계산 | **Read-time** (옵션 A): 추출 모달에서만 정규화 | 데이터 0건 수정, 비파괴 |
| 가상승급 알고리즘 | `base(level) + grade`를 누적학년으로 보고 단순 overflow 흡수 | 비원생도 매년 grade +1된다는 사용자 확인 |

### Read-time(옵션 A)을 채택한 이유

- 시스템에 이미 비정상 학년값(초11 등)이 존재 → Write-time mutate(옵션 B)로 가려면 일괄 정상화 마이그레이션이 비가역적으로 필요
- 정규화 알고리즘 한 곳(`normalizeRealLevelGrade`)에 캡슐화하면 향후 수정·재사용·옵션 B 전환에도 그대로 활용 가능
- 추출 모달에서만 호출되므로 다른 화면(학생 카드, 사이드바 필터, DSC/HR/exam 등)에 영향 0

### `withdrawal_date` 기반 가산을 쓰지 않는 이유

비원생도 매년 grade가 +1되는 외부 프로세스가 동작 중이므로, `grade` 자체가 이미 "현재 시점 학년"을 누적 표현한다. 여기에 `withdrawal_date`로 추가 가산하면 이중계산이 된다. 따라서 `base + grade`만 신뢰하고 overflow 흡수만 수행한다.

## 3. 아키텍처

### 3.1 모듈 구성 (AGENTS.md 규칙 1 준수)

```
promo-extractor.js    [신규]
  └─ openPromoExtractModal()        모달 진입점 (window 등록)
  └─ normalizeRealLevelGrade(s)     가상 학년 정규화 (순수 함수)
  └─ pickPrimaryPhone(s)            대표 전화 선택
  └─ filterRecipients(filters)      필터 적용 + 정규화 + 전화 누락 제외
  └─ renderTable(rows, el)          테이블 + 체크박스 렌더링
  └─ copySelectedPhones()           체크된 행 대표번호 클립보드 복사
  └─ exportToGoogleSheet(rows)      sheet-export.js 헬퍼 호출

sheet-export.js       [신규]
  └─ createGoogleSheet(title, headers, rows)
       (handleSheetExport에서 시트 생성 로직만 추출 — 기존 함수는 미수정)

index.html            [수정]
  └─ 사이드바 Registration 버튼 아래 "홍보 추출" 버튼 추가
  └─ 모달 마크업 추가

app.js                [무수정]
```

### 3.2 데이터 흐름

```
사용자가 사이드바 "홍보 추출" 클릭
    ↓
openPromoExtractModal()
    ↓
모달 표시, 기본 필터(상태=재원, 학부×학년 그리드 전체 체크)로 초기 렌더
    ↓
필터 변경 시마다:
    1. store.allStudents에서 상태 필터 1차 적용
    2. 각 학생에 normalizeRealLevelGrade(s) 호출 → (normLevel, normGrade)
    3. 그리드에서 체크된 키 집합(예: {"중3","고1","졸업"})에
       정규화 결과 키가 포함되는 학생만 통과
       - 일반 학생 키: `${normLevel}${normGrade}` (예: "고1")
       - 졸업 학생 키: `"졸업"` (grade 무관 — 졸업+1, 졸업+2 모두 동일 셀)
    4. pickPrimaryPhone(s)로 대표번호 산출, 빈 전화는 제외
    5. 중복 전화 자동 병합(토글 기본 ON)
    6. 테이블 렌더 + 카운트 표시
    ↓
사용자 액션:
    - 행 체크박스: 선택 토글
    - "전체선택": 보이는 모든 행 토글
    - "선택 복사": 체크된 행 대표번호를 쉼표 구분 문자열로 클립보드 복사
    - "Google Sheets": 체크된 행을 새 시트로 생성 (헤더: 이름/학부/학년/학교/대표번호/상태)
```

## 4. 핵심 알고리즘: `normalizeRealLevelGrade`

```javascript
const LEVEL_CUMULATIVE_START = { '초등': 0, '중등': 6, '고등': 9 };

function normalizeRealLevelGrade(s) {
    const gradeNum = parseInt(s.grade, 10);
    // 학년 미입력은 학부만 반환 — 임의 셀에 배정되지 않도록
    if (isNaN(gradeNum) || gradeNum <= 0) {
        return { level: s.level || '초등', grade: 0, graduated: false };
    }
    const base = LEVEL_CUMULATIVE_START[s.level] ?? 0;
    const cumulative = base + gradeNum;

    if (cumulative <= 6)  return { level: '초등', grade: cumulative,        graduated: false };
    if (cumulative <= 9)  return { level: '중등', grade: cumulative - 6,    graduated: false };
    if (cumulative <= 12) return { level: '고등', grade: cumulative - 9,    graduated: false };
    return { level: '졸업', grade: cumulative - 12, graduated: true };
}
```

순수 함수. 테스트 매우 쉬움.

### 4.1 동작 예시

| 입력 | 출력 | 비고 |
|---|---|---|
| `{level:'초등', grade:3}` | 초3 | 정상 데이터 |
| `{level:'초등', grade:11}` | 고2 | 누적 11 → 고2 (사용자 사례) |
| `{level:'중등', grade:5}` | 고2 | 누적 6+5=11 → 고2 |
| `{level:'고등', grade:4}` | 졸업+1 | 누적 9+4=13 → 졸업+1 |
| `{level:'중등', grade:3}` | 중3 | 정상 데이터, 경계값 |
| `{level:'초등', grade:6}` | 초6 | 정상 데이터, 경계값 |

## 5. UI 명세

### 5.1 사이드바 진입점

`index.html` Registration 버튼(line 44 근처) 바로 아래:

```html
<button class="action-btn-registration" onclick="window.openPromoExtractModal()" style="...">
  <span class="material-symbols-outlined">campaign</span>
  홍보 추출
</button>
```

스타일은 Registration 버튼과 동일한 톤 유지. 권한 가드 필요 시 관리자만 표시(추후 검토).

### 5.2 모달 레이아웃

```
┌─ 홍보 수신자 추출 ───────────────────────────────── [×]
│
│  상태:  [ All ] [●재원] [ 비원 ]
│
│  학부×학년:                                   [전체↓]
│              1    2    3    4    5    6
│    초등    [□]  [□]  [☑]  [☑]  [□]  [□]    [□행전체]
│    중등    [□]  [□]  [☑]   -    -    -     [□행전체]
│    고등    [☑]  [□]  [□]   -    -    -     [□행전체]
│    졸업    ───────────────────────────────  [□]
│
│  ☑ 동일 번호 자동 병합
│
│  ─── 결과: 47명 (전화 누락 3명 제외 / 중복 1건 병합) ───
│
│  [□ 전체선택]    [선택 복사]  [구글시트 다운로드]
│
│  ┌─────────────────────────────────────────────┐
│  │ □ 이름    학부 학년 학교       대표번호       │
│  │ ☑ 김지유  초등 3   2단지초     010-1234-…    │
│  │ ☑ 이서연  중등 3   10단지중    010-2345-…    │
│  │ ...                                           │
│  └─────────────────────────────────────────────┘
└────────────────────────────────────────────────────
```

### 5.3 상호작용 세부

- 그리드 각 셀은 독립 체크박스 → "초3, 초4 + 중3 + 고1" 같은 임의 조합 가능
- 행 우측 "행 전체" 체크박스: 해당 학부의 모든 학년 셀 동시 토글
- 그리드 우상단 "전체↓": 모든 셀 일괄 토글
- 졸업 행은 학년 셀 없이 단일 체크박스 (graduated=true 학생용)
- 필터 변경 시 즉시 리렌더 (디바운스 불필요 — 메모리 연산)
- 헤더 카운트는 `매칭 N명 · 전화 누락 M명 제외 · 중복 K건 병합` 형식
- 초기 상태: 그리드 전체 체크 + 상태=재원 (자주 쓰는 시나리오 디폴트)

## 6. 다운로드 / 복사

### 6.1 선택 복사

체크된 행의 대표번호를 `,`로 join하여 `navigator.clipboard.writeText`. 권한 거부 시 textarea + `execCommand('copy')` fallback.

### 6.2 Google Sheets 다운로드

`sheet-export.js`의 `createGoogleSheet(title, headers, rows)` 호출.

- `title`: `홍보수신자_YYYY-MM-DD_<필터요약>` (예: `홍보수신자_2026-05-18_재원·초3-4`)
- `headers`: `['이름', '학부', '학년', '학교', '대표번호', '상태']`
- `rows`: 체크된 학생들의 행
- 시트 생성 후 새 탭으로 열기 (기존 `handleSheetExport` 동작 동일)

`sheet-export.js`는 기존 `app.js:3046-3138`의 시트 생성·서식·자동맞춤 로직을 일반화하여 추출한다. 기존 `handleSheetExport`는 이번 PR에서 건드리지 않는다 — 다음 수정 시점에 자연스럽게 통합.

## 7. 에러 처리

| 상황 | 동작 |
|---|---|
| 필터 결과 0명 | 테이블 영역에 "조건에 맞는 학생이 없습니다" |
| OAuth 토큰 없음(시트 생성 시) | 기존 `handleSheetExport`와 동일한 안내 alert |
| 시트 생성 API 실패 | 에러 메시지 alert + 시트 URL 미열림 |
| 클립보드 권한 거부 | textarea fallback으로 select+execCommand('copy') |

## 8. 테스트 시나리오

- [ ] `normalizeRealLevelGrade({level:'초등', grade:3})` → `{level:'초등', grade:3, graduated:false}`
- [ ] `normalizeRealLevelGrade({level:'초등', grade:11})` → `{level:'고등', grade:2, graduated:false}`
- [ ] `normalizeRealLevelGrade({level:'고등', grade:4})` → `{level:'졸업', grade:1, graduated:true}`
- [ ] 재원 + 그리드 {초3, 초4} 체크 → 초3·초4만 카운트
- [ ] 재원 + 그리드 {중3, 고1} 체크 → 중3·고1만 카운트 (학년 교차 조합)
- [ ] 비원 + 그리드 전체 체크 → 가상승급 적용된 학년으로 표시
- [ ] 비원 + 졸업 셀만 체크 → 가상승급 결과 고3 초과한 학생만 표시
- [ ] "초등 행 전체" 클릭 → 초1~6 동시 토글
- [ ] `초등 11학년` 데이터가 추출 화면에서 `고2`로 표시
- [ ] 동일 학부모₁ 전화를 가진 형제 2명 → 병합 토글 ON 시 1건, OFF 시 2건
- [ ] 전화 누락 학생 제외, 카운트에 반영
- [ ] 선택 복사 후 SMS 도구에 붙여넣어 형식 검증
- [ ] Google Sheets 생성 시 헤더 굵게·필터 적용 확인

## 9. 범위 외 (Out of Scope)

- `runPromotion` 자동승급 정책 변경 (퇴원생 포함 등) — 이번 PR에 포함하지 않음
- 비원생 데이터 정상화 마이그레이션 (초11 → 고2 영구 변환) — Read-time 정규화로 충분
- CSV/Excel 다운로드 — 사용자 요청 시 추후 추가
- DSC/HR/exam 앱 영향 — `level='졸업'`을 DB에 저장하지 않으므로 영향 없음
- 비원생 grade +1 외부 프로세스의 점검 — 별도 작업

## 10. 마이그레이션 / 데이터 변경

**없음.** 신규 컬렉션·문서·필드 추가도 없음.

## 11. 후속 작업 후보

- 비원생 데이터 정상화(원하면) — 본 정규화 함수를 그대로 마이그레이션 스크립트로 활용
- 추출 결과를 `notification_history` 같은 컬렉션에 로깅(누구에게 무슨 캠페인 보냈는지)
- 학년 필터 외에 "퇴원 후 N개월" 같은 기간 필터
- 자동승급 메뉴에 비원생 포함 옵션 (옵션 B 전환 시점)
