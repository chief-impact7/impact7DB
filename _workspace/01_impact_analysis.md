# 2단계 영향 분석: 실데이터 유입·전환 현황

- 작성일: 2026-07-14
- 대상: `impact7DB`, `DashBoard`, 공유 `firestore.rules`
- 결과: 신규 상담 등록부터 유입 채널·상담 관을 보존하고, 기존 이력으로 상담→등원예정→등록 퍼널을 계산한다.

## 데이터 계약

- `students.acquisition_source`: 최초 유입 채널. 값이 없던 레거시 문서만 1회 보완 가능하다.
- `students.acquisition_branch`: 최초 상담 관(`2단지` 또는 `10단지`). 현재 수업 관인 `branch`와 분리하며 최초값을 보존한다.
- 공유 Rules에서는 다른 IMPACT7 앱과 레거시 생성 호환을 위해 두 필드를 선택적으로 허용한다.
- impact7DB 신규등록 UI에서는 두 필드를 필수로 받고, 편집·재등록 시 기존 값이 있으면 덮어쓰지 않는다.
- 레거시 미입력 상담 관은 현재 수업 관으로 추정하지 않는다. 전체 집계에는 포함하되 관별 필터에서는 제외한다.

## 구현 범위

### impact7DB

- 신규/편집 폼에 유입 채널과 상담 관을 추가했다.
- 수업 없는 신규 학생은 `상담`, 수업이 있으면 `등원예정` 또는 `재원`으로 저장한다.
- 신규·편집·재등록 이력에 구조화된 상태 변화를 남긴다.
- Firestore Rules에서 두 필드의 타입·값·길이를 검증하고, 최초 입력 후 변경을 차단한다.

### DashBoard

- 재원·상담·퇴원·종강 학생과 `history_logs`를 함께 읽는다.
- CONSULT, PLAN, ENROLL, PAUSE, RESUME, WITHDRAW, REENROLL 이벤트를 재생한다.
- 재등록 학생의 과거 ENROLL을 현재 재등록 시작일 때문에 PLAN으로 바꾸지 않는다.
- 신규생 페이지의 KPI·추이·유입 퍼널을 모두 상담 관 기준 컨텍스트로 계산한다.
- 인원현황 페이지는 기존 현재 수업 관 기준을 유지한다.

## 호환성과 제한

- 새 컬렉션, 인덱스, 백필은 없다.
- 과거 `acquisition_source`·`acquisition_branch`가 없는 학생은 `미입력`으로 남는다.
- 기존 기록은 학생을 편집할 때 1회 보완할 수 있다.
- Firestore Rules는 네 저장소에 byte-identical하게 동기화한다.

## 배포 조건

- impact7DB unit/rules/build 통과
- DashBoard test/lint/build 통과
- 독립 코드 리뷰 APPROVE, 아키텍처 리뷰 CLEAR
- 네 Rules 파일 SHA-1 일치
- 저장소별 선별 커밋·푸시 후 Firestore Rules와 호스팅 배포 성공
