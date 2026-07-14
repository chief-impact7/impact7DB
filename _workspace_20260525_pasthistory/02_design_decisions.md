# 설계 결정사항: 이전 학원생활 뷰

## 결정 요약

| # | 항목 | 결정 |
|---|---|---|
| 1 | 담당 선생 변천사 추적 | **하지 않음**. 과거 수업의 학기별 반 코드만 표시 (변천사 별도 추적 X). Phase 2(`class_teacher_history` 컬렉션) 폐기. |
| 2 | "과거" 정의 | enrollment의 `end_date < today` + **history_logs 텍스트 파싱으로 종강된 정규도 복원** |
| 3 | 노출 범위 | 모든 학생 (재원/비재원 무관, 단 UI 배치는 상태 분기) |
| 4 | 휴원 사이클 표현 | **간단하게 묶어 표시** (한 사이클을 1개 카드로 압축, 각 leave_request row 모두 펼치지 않음) |
| 5 | 별건 룰 버그 | **함께 패치** — `firestore.rules:132`의 `change_type` enum에 `RESTORE`, `LR_AMEND` 추가 |
| 6 | UI 배치 | **학생상태에 따라 우측 패널 컨텐츠 자체가 전환** |

## UI 분기 기준 (결정 6 상세)

```
if (학생.status ∈ ACTIVE_STATES) {
    // 우측 패널 = 학생상세 (현재 그대로)
    // 탭: 기본정보 / 수업이력
} else {
    // 우측 패널 = 과거이력 뷰 (신설)
    // 별도 탭 없이 단일 뷰
}
```

- **ACTIVE_STATES** = `['재원', '등원예정', '실휴원', '가휴원']` (`app.js:2514`)
- **그 외** = `퇴원`, `종강`, `상담` 등

## 수정된 구현 계획

원래 Phase 2(`class_teacher_history` 컬렉션 신설)가 폐기되어 작업이 단순화됨:

| Phase | 작업 | 영향 앱 | 룰 변경 |
|---|---|---|---|
| **1** | DB 측 과거이력 뷰 + 학생상태 분기 + 룰 enum 패치 | DB | ✅ (`RESTORE`/`LR_AMEND` enum 추가) |
| **2** | DSC 측 동일 미러 | DSC | - (Phase 1의 룰 동기화 받음) |

룰 변경 1건이므로 4프로젝트 동기화는 필요 (`firestore-rules-sync` 스킬).

## 데이터 출처 (Phase 1·2 공통)

| 정보 | 출처 | 가공 방법 |
|---|---|---|
| 과거 수업/반 이력 | `students.enrollments[]` + `history_logs` | `end_date < today`인 enrollment + history_logs에서 "종강 처리: code (정규)" 텍스트 파싱 |
| 휴원/퇴원 사이클 | `leave_requests` + `history_logs` | `leave_requests` row를 사이클 단위로 묶고 1개 카드로 압축 |
| 사유 | `leave_requests.consultation_note` | 사이클 카드에 표시 |
| 일자 | `leave_requests.leave_start_date/leave_end_date/withdrawal_date/return_date` | 사이클 카드에 표시 |
| 담당 선생 (현재만, 변천사 없음) | `class_settings[code].teacher` → `teachers/{email}.display_name` | 각 enrollment 카드에 부기 |

## 모듈 분리 계획

**DB (`/Users/jongsooyi/IMPACT7/impact7DB/`)**:
- 신설 `past-history.js` — 과거이력 데이터 페치·렌더링
- `store.js`에서 `currentStudentId`, `allStudents` import
- `index.html`에 `<div id="past-history-view">` 컨테이너 추가
- `selectStudent`/`switchDetailTab`에 학생상태 분기 추가 (소규모 수정)

**DSC (`/Users/jongsooyi/IMPACT7/impact7newDSC/`)**:
- 신설 `past-history.js` — DB와 동일 패턴
- `student-detail.js`(1365줄)에 추가하지 않고 분리

## 위험도 (재평가)

**종합: 낮음~중간**

| 항목 | 위험도 | 사유 |
|---|---|---|
| Phase 1 (DB 코드) | 낮음 | 읽기 전용, 인덱스 존재 |
| Phase 1 (룰 변경) | 중간 | 4프로젝트 동기화 필요 — `firestore-rules-sync` 자동화 활용 |
| Phase 2 (DSC) | 낮음 | UI 미러링 |
| 데이터 일관성 | 중간 | history_logs 텍스트 파싱 의존 — 기존 `_summarizeHistoryText`/`_categorizeHistoryLog` 재사용 |

원래 분석의 Phase 2(class_teacher_history)가 제거되어 위험도가 한 단계 낮아짐.
