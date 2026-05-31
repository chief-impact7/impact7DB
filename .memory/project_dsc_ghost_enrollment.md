---
name: project-dsc-ghost-enrollment
description: 재원인데 DSC 검색·출결에서 누락되는 "유령 학생" — 모든 enrollment의 end_date가 과거일 때 발생
metadata:
  type: project
---

# DSC 유령 학생 — 활성 enrollment 0건

**증상:** DB 검색창에는 나오는데 DSC 검색·출결 목록에 안 나오는 재원생.

**원인:** DSC 검색 풀은 "활성 enrollment ≥ 1건"을 요구한다 (`daily-ops.js:1616-1625`).
활성 판정은 `end_date < 오늘`이면 종료로 본다 (`student-helpers.js:185` getActiveEnrollments).
정규 enrollment는 본래 end_date 무기한이어야 하는데, 과거 일회성 `naesin-cleanup` 작업이
정규 구간을 end_date로 닫고 **후속 정규 구간(복귀)을 안 열어서** 활성 enrollment가 0건이 됨.
DB는 `status='재원'`만 보므로 정상 노출 → 두 앱 불일치.

**정상 패턴 vs 사고:** 반 이동·내신 분할은 `{정규|~과거end} + {정규|새start~무기한}` 쌍이 정상
(닫고-열기). 한쪽만 닫고 후속을 안 열면 유령이 된다.

**2026-05-31 사례:** 이예원(`이예원_1052714208`, 선유고2). 유일 enrollment가
`{정규|2025-05-08~2026-05-12|ovr=2단지선유고2B}` 단일 구간으로 닫혀 활성 0건.
→ end_date 제거로 복구(원본 백업 `_workspace/lyw-ghost-backup.json`).
전수조사(15,675명): 동일 증상은 이 1명뿐. 유사(정규에 과거 end_date) 47명은 모두 후속 활성 구간 있어 정상.

**전수조사 쿼리:** 활성 status(`{재원·등원예정·실휴원·가휴원}`, = NOT `{퇴원·종강·상담}`) + enrollments≥1 +
`!enrollments.some(e => !(validDate(e.end_date) && e.end_date < TODAY))` → 활성 0건이면 유령.

## 정규 end_date 규칙 (도메인 규칙, 사용자 확인 2026-05-31)
- **현재 활성 정규는 end_date 없음**(무기한). end_date를 운영상 잡는 건 내신/자유학기/특강뿐.
- 단 반 이동/신학기 정규 등록 시 시스템이 **옛 정규 구간에 end_date=새시작일-1을 자동으로 박고** 새 정규 구간을 추가한다(`class-setup.js:1271-1285`). → 종료된 옛 정규 이력엔 end_date 있음(정상, 반이동 흔적).
- 부류B(활성 정규 0인데 정규에 end_date = 사고) 전수=0건(이예원 수정 후).

## 정규 day(요일) = enrollment.day SSoT, 내신 요일 = class_settings[csKey].schedule
- 정규반 요일은 `enrollment.day` 배열(활성 375건 중 356 채워짐). 내신반은 class_settings.schedule(예: 2단지선유고2B `{화:17:00,목:17:00}`).
- **가드 맹점→강화 완료(2026-05-31)**: 내신/자유학기반 추가 가드(`class-setup.js`, `naesin.js`)가 `class_type==='정규'` **존재만** 검사하던 맹점 → `isActiveNaesinBase(e)`(student-helpers.js)로 교체. **정규=활성(end_date 미과거)+요일 보유, 자유학기=활성** 요구. 내신반 override 박는 map도 동일 helper로 제한(죽은 정규에 override 잔존 방지). DB는 내신 추가를 막고 DSC로 위임(`app.js:3056`)하므로 **가드는 DSC 단일 앱**.
- **2026-05-31 day 백필**: override 보유 활성정규인데 day 빈 14명(내신 끝나면 정규 출결 누락 시한폭탄) → 같은 반 표준요일(만장일치 화목)로 복구. 김지유는 HX106→HX108 반이동(사용자 지시)+HX108 요일·시간(HX108은 시간 미설정 반이라 빈값). 백업 `_workspace/day-backfill-backup.json`, 잔여 0.
- **이예원 day**: HS102(2단지) 4명 만장일치 `["목","화"]`로 복구. 백업 `_workspace/lyw-day-backup.json`.

studentNumber(#육자리)는 전화 앞6자리(010제거) 파생 — [[project-student-display-unification]] 무관, 동명이인은 전화가 다르면 번호도 다름.
관련: [[project_class_move_unification]] 반 이동 닫고-열기, [[feedback_enrollment_status_consistency]]
