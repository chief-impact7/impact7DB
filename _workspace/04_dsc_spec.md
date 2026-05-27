# DSC 구현 스펙 — 학생 표시 통일 (Phase: DSC)

상위 이니셔티브: impact7DB `.memory/project_student_display_unification.md`
DB는 커밋 6717ab4로 완료. DSC도 동일 기준으로 통일하되, DSC는 출결 표시를 병기한다.

## 0. 선행 — 공유 모듈 bump (필수)
DSC는 현재 `@impact7/shared#v1.3.0`이라 신규 export가 없다. **먼저 v1.4.0로 올린다:**
1. `package.json`: `"@impact7/shared": "github:chief-impact7/impact7-shared#v1.4.0"`
2. `npm install`
3. v1.4.0 export 확인: `selectableStatuses, studentCategory, STATUS_TONE`(+기존 `isEnrollableStatus, reconcileEnrollments`)

## 1. 사용할 공유 API
```
import { selectableStatuses, studentCategory, STATUS_TONE } from '@impact7/shared/enrollment-status';
```
- `STATUS_TONE`: { 재원:'active', 등원예정:'scheduled', 실휴원:'paused', 가휴원:'paused', 상담:'consult', 퇴원:'ended-hard', 종강:'ended-soft' }
- `studentCategory(status)` → '재원생'(재원/등원예정/실휴원/가휴원) | '비원생'(상담/퇴원/종강)
- `selectableStatuses(current, isNew)` — 폼 전이 옵션

## 2. tone CSS — DB와 **동일 hex 미러 (SSoT, 정확히 일치시킬 것)**
DSC CSS에 tone 6종 클래스 추가(클래스명·hex 동일). DSC 기존 status 배지 색을 이 tone으로 교체:
```
.tone-active     { background: var(--sbux-light); color: var(--sbux-green); }   /* DSC에 sbux 변수 없으면 동등 초록으로 */
.tone-scheduled  { background: var(--sbux-light); color: var(--sbux-accent); }
.tone-paused     { background: #fef7e0; color: #b06000; }
.tone-consult    { background: #ede7f6; color: #5e35b1; }
.tone-ended-hard { background: #fce8e6; color: #c5221f; }
.tone-ended-soft { background: #eceff1; color: #546e7a; }
```
※ DSC 컬러 변수(--sbux-*)가 DB와 다르면, active=초록/scheduled=파랑 계열로 시각 동등하게 맞춘다.

## 3. 작업 항목
**(a) 폼 전이** — DSC에 학생 status를 고르는 폼/select가 있으면 `selectableStatuses(current, isNew)`로 옵션 동적 생성 (신규=등원예정/재원만, 비원생→등원예정/재원+현상태, 재원생만 휴원 진입). DSC에 마스터 status 편집 폼이 없으면 이 항목은 "해당 없음"으로 보고.

**(b) 헤더 배지 + 출결 병기** — DSC 학생 상세 헤더에 **마스터 status를 tone 배지로 표시**. ⚠️ 기존 출결 표시(`absence-status-badge` 등)는 **그대로 두고 나란히 병기**(replace 금지). 즉 헤더에 [재원(tone)] [오늘 출결] 식으로 두 배지 공존.

**(c) 목록 2계층** — DSC에 학생 목록(마스터 status 기준)이 있으면 `studentCategory()`로 재원생/비원생 섹션 분리. ⚠️ DSC의 **일별 출결 목록**(daily-ops)은 출결용이므로 건드리지 말 것 — 2계층은 "학생 마스터 목록" 성격의 화면에만 적용. 해당 화면이 없으면 "해당 없음" 보고.

## 4. 제약·검증
- DSC 코드 컨벤션·모듈 구조를 따른다. status 배지 생성이 여러 곳이면 DB의 `statusBadgeHtml`처럼 헬퍼로 통합 권장.
- `npm run build` 성공 확인.
- **커밋/푸시 금지** — 사용자가 DSC 실화면 확인 후 결정.
- 출결(absence) 관련 기존 동작·배지는 절대 변경하지 말 것. 이번 작업은 "마스터 status 표시 통일"만.

## 5. 보고
변경 파일·함수·라인, 빌드 결과, 그리고 **(a)(b)(c) 각 항목별로 "DSC에 해당 화면이 있었는지/어떻게 적용했는지/해당 없으면 그 이유"**를 명확히 보고. 출결 병기를 정확히 어디에 어떻게 배치했는지 1-2문장. 보고서를 `_workspace/05_dsc_implementation.md`에 저장.
