# DSC 구현 결과 — 학생 표시 통일 (Phase: DSC)

상위 이니셔티브: impact7DB `.memory/project_student_display_unification.md`
DB 완료 커밋 6717ab4 기준으로 DSC를 동일 SSoT(@impact7/shared/enrollment-status)로 통일.
**커밋/푸시 안 함** — 사용자 실화면 확인 대기 중.

## 0. 선행 — 공유 모듈 v1.4.0 bump (완료)

- `package.json`: `@impact7/shared` `#v1.3.0` → `#v1.4.0`
- `npm install`이 github 태그 캐시 때문에 v1.3.0을 고수 → `package-lock.json`의 `node_modules/@impact7/shared` 항목(version + resolved commit hash)을 DB lock의 v1.4.0 값(`6eb10e2c2b88f230a5f25c661156d40abd652af9`)으로 직접 갱신 후 `npm install`로 정합화.
- v1.4.0 export 확인: `selectableStatuses, studentCategory, STATUS_TONE, STUDENT_STATUS_GROUPS, INITIAL_STATUSES` (+기존 `isEnrollableStatus, reconcileEnrollments`) 모두 존재.

## 변경 파일·함수·라인

| 파일 | 위치 | 내용 |
|------|------|------|
| `package.json` | dependencies | shared #v1.4.0 |
| `package-lock.json` | @impact7/shared 항목 | v1.4.0 / commit 6eb10e2 |
| `student-detail.js` | import(11) | `STATUS_TONE` 추가 import |
| `student-detail.js` | 모듈 상단(48-51) | `statusToneClass`, `statusToneBadgeHtml` 헬퍼 신규 |
| `student-detail.js` | `renderStudentDetail`(1018-1026) | profile-tags에 마스터 status tone 배지 병기 |
| `daily-ops.css` | 1010-1021 | tone 6종 + `.tag-master-status` 클래스 정의 |

- 빌드: `npm run build` 성공 (vite 7.3.1, 743 modules, ~5.4s). 에러·신규 경고 없음.

## (a) 폼 전이 — selectableStatuses → **해당 없음**

- DSC에는 사람이 학생 마스터 status를 골라 저장하는 폼/select가 **존재하지 않음**.
- DSC가 `students.status`를 쓰는 곳은 전부 자동화 로직이며 사람이 status를 선택하는 UI가 아님:
  - `data-layer.js` `promoteEnrollPending`(등원예정→재원 자동 승격), 휴원 복귀/퇴원 자동 batch
  - `diagnostic.js`(진단평가 등록 시 '상담' 자동 부여)
- 마스터 status 편집은 DB 앱 전담(`students`는 DSC에서 읽기 전용 원칙). 따라서 `selectableStatuses` 적용 대상 없음 → 미적용. (헬퍼는 import만 하지 않음; 불필요 import 추가 안 함.)

## (b) 헤더 배지 + 출결 병기 — **적용** (Option C 정밀 수정 반영)

- 화면: `student-detail.js` `renderStudentDetail()` → `#profile-tags` (학생 상세 헤더, index.html:221).
- 마스터 `student.status`는 새 tone 배지(`statusToneBadgeHtml` → `<span class="tag tag-master-status tone-*">`)가 **전담**해 profile-tags 맨 앞에 prepend.
- 기존 `tag-status` 배지는 마스터 status 단어를 **빼고 보조정보만** 남기도록 비활성 분기 축소 (Option C). 이로써 비활성 학생에서 status 중복 표시 제거:

| status | tone 배지 | 보조 `tag-status` 배지 |
|--------|-----------|----------------------|
| 재원(활성) | 재원 | **현행 그대로** 출결/수업 (출석 9:00, 정규, 내신 등) — else 분기 미접촉 |
| 실/가휴원 | 실휴원/가휴원 | 휴원 기간만 `~MM-DD` (종료일), 종료일 없으면 `MM-DD~` |
| 퇴원 | 퇴원 | 퇴원 날짜만 `MM-DD` (없으면 미렌더) |
| 등원예정 | 등원예정 | 등원예정일 `MM-DD` (없으면 미렌더) |
| 상담/종강 | 상담/종강 | 미렌더 (빈 문자열) |

- **출결 병기**: 재원 활성 else 분기(student-detail.js ~1011-1018, 출결/수업 텍스트)는 **한 글자도 변경 안 함**. `attStatus`·`arrivalTime`·`_isNaesinActiveAt`·`formatTime12h` 등 출결 로직 미접촉. → `[재원(tone)] [출석 9:00]`로 두 배지 공존.
- **보조 배지 조건부 렌더**: `tagText`가 빈 문자열이면 `tag-status` span 자체를 렌더 안 함(빈 칩 방지). 상담/종강·날짜 없는 퇴원/등원예정은 tone 배지만 노출.
- **등원예정일 출처**: 전용 헬퍼가 없어 직접 계산 — `student.enrollments`에서 `start_date`가 미래(`> today`, today=`state.selectedDate||todayStr()`)인 것 중 사전순 최솟값(`futureStarts.sort()[0]`, ISO 날짜라 사전순=시간순). data-layer의 `promoteEnrollPending`이 쓰는 `start_date > today` 판정과 동일 기준.
- **날짜 포맷**: DSC 전역 ISO 날짜 단축 관례인 `_stripYear`(ui-utils, `YYYY-MM-DD`→`MM-DD`) 사용. (test-management·hw-management·reschedule-modal 등이 scheduled_date/makeup_date에 동일 사용.)
- ⚠️ `absence-status-badge`(absence-records.js / leave-request.js 결석·휴원 처리 카드)는 헤더와 무관 — 전혀 건드리지 않음.
- 배지 생성은 DB의 `statusToneClass`/`statusBadgeHtml` 패턴을 미러한 헬퍼로 통합.

**변경 라인(2차 정밀 수정):**
- student-detail.js 16: import에 `_stripYear` 추가
- student-detail.js 985-1019: tagText 비활성 4분기(퇴원/휴원/등원예정/비재원)를 보조정보로 축소
- student-detail.js 1025-1035: `auxBadgeHtml` 조건부 렌더(tagText 있을 때만)로 profile-tags 조립

## (c) 목록 2계층 — studentCategory → **해당 없음**

- DSC의 유일한 학생 목록은 `daily-ops.js` `renderListPanel`로, 선택일의 요일·enrollment·출결 카테고리 기반 **일별 출결 목록**(검색 시 비원생 섹션을 `_renderPastContacts`로 보조 노출).
- 이는 스펙 4번·(c)가 명시적으로 "건드리지 말 것"으로 제외한 daily-ops 출결 목록. DSC에는 "마스터 status 기준 학생 마스터 목록" 성격의 화면이 따로 없음 → 2계층 미적용.
- (참고: DSC는 이미 출결 목록에서 재원생 본문 + 비원생 검색 섹션을 자체 분리하고 있으나, 이는 출결 동작이므로 변경 대상 아님.)

## tone CSS — DB와 hex 정확 일치 (SSoT 미러)

DSC는 `--sbux-*` 변수가 없고 `--primary:#00754A / --primary-light:#d4e9e2 / --success:#006241`를 사용.
DB의 sbux 실제 값(`--sbux-light:#d4e9e2, --sbux-green:#006241, --sbux-accent:#00754A` — accent도 초록)과 DSC 변수가 동일 hex라 변수로 매핑해도 **hex 완전 일치**:

```
.tone-active     { background: var(--primary-light); color: var(--success); }  /* #d4e9e2 / #006241 */
.tone-scheduled  { background: var(--primary-light); color: var(--primary); }  /* #d4e9e2 / #00754A */
.tone-paused     { background: #fef7e0; color: #b06000; }
.tone-consult    { background: #ede7f6; color: #5e35b1; }
.tone-ended-hard { background: #fce8e6; color: #c5221f; }
.tone-ended-soft { background: #eceff1; color: #546e7a; }
```

상담=#5e35b1/#ede7f6, 종강=#546e7a/#eceff1 등 스펙 hex와 정확히 일치.
헤더 배지는 DB와 동일하게 `.tag` 스케일 위에 tone으로 색만 입힘.

## 함정 메모 — daily-ops.css 줄끝(CRLF/LF)

- `daily-ops.css`는 **혼합 줄끝**(원본 4107줄 중 CRLF 3978 + LF 129). Edit 도구가 LF로 쓰면 git이 주변 라인까지 대량 변경(246줄)으로 인식.
- 해결: 파일을 `git checkout`으로 복원 후, tone 블록을 perl로 **CRLF(`\r\n`) 그대로** `.tag-past` 앞에 삽입 → diff가 정확히 +12줄로 클린. (세션 메모리의 "line ending 함정"과 동일 사례.)

## 검증·후속

- `npm run build` 성공(2차 수정 후 재확인, ~4.6s, 신규 경고 없음).
- 최종 diff: daily-ops.css +12 (CRLF 클린), student-detail.js +31/-11, package(.json/lock) shared 버전만. student-detail.js는 LF 파일이라 줄끝 이슈 없음.
- 미적용 항목 (a)(c)는 화면 부재가 사유이며 DSC 출결(absence)·daily-ops 동작은 일절 변경 없음.
- 다음: 사용자가 DSC 실화면 확인 후 커밋 결정. 확인 포인트 — 재원: `[재원][출석 9:00]`, 휴원: `[실휴원][~05/30]`, 퇴원: `[퇴원][05/01]`, 등원예정: `[등원예정][06/02]`, 상담/종강: tone 배지 단독.
