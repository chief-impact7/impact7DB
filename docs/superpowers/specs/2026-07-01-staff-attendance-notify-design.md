# 직원 출퇴근 알림 설계

**목표:** 직원이 태블릿에서 출근/퇴근/외출/귀원을 처리하면, HR에서 지정한 번호로
알림톡(실패 시 SMS)을 발송한다. 학생의 학부모1 알림과 대칭 구조.

**아키텍처:** 학생 알림 인프라(`message_queue` + 워커의 알림톡→SMS 이중화)를 재사용한다.
`staffCheckinHandler`가 처리 성공 시 `message_queue`에 payload를 적재하면, 기존 워커가
알림톡 우선 + 실패 시 SMS 대체를 그대로 수행한다. 신규는 **직원용 템플릿**과
**staff 알림번호 필드**뿐 — 최소 코드, 학생과 대칭.

## 확정 요구사항
- **대상:** 직원별 각자 번호. HR 직원현황(personnel) **빠른추가 + 수정** 폼에 필드.
- **채널:** 알림톡 우선 + 실패 시 SMS (학생과 동일 이중화).
- **범위:** 출근/퇴근/외출/귀원 4종 전부.

## 설계

### 1. 데이터 모델
`staff` 컬렉션에 `attendanceNotifyPhone`(string, optional) 추가. 직원 본인 `phone`과
별개(가족 지정 가능). 값이 비어 있으면 알림을 생략한다.
- impact7HR `src/lib/types/index.ts` 의 `Staff` 인터페이스에 optional 필드 추가.

### 2. HR UI — `impact7HR/src/routes/personnel/+page.svelte`
빠른추가·수정 폼에 **"출퇴근 알림 번호"** 입력란 추가. 저장 시 staff 문서에 기록.
전화 표기/정규화는 기존 `@impact7/shared/phone`(formatPhone) 재사용.

### 3. 백엔드 — `impact7DB/functions-shared/src/staffCheckinHandler.js`
확정 처리(`result: 'created'`) 성공 시:
- 해당 직원의 `attendanceNotifyPhone`이 있으면 `message_queue`에 payload 1건 적재.
- payload는 학생 `buildEventQueuePayload`에 대응하는 `buildStaffEventQueuePayload`:
  `kind: 'attendance'`, `recipient_phone`=알림번호, `template_code`=직원 템플릿,
  `template_variables`={이름, 종류, 시각}, `fallback_text`(SMS 문구), `source: 'tablet'`.
- 워커가 알림톡 우선 + 실패 시 SMS 대체(기존 로직 그대로).
- 번호 없으면 생략. **알림 실패해도 출퇴근 기록은 성공**(best-effort, 학생과 동일).
- 멱등(연타, `result: 'duplicate'`) 경로는 알림 미발송(중복 방지).

### 4. 템플릿 — 직원 출퇴근 알림톡 신규
`parentNoticeHandler`의 `PARENT_NOTICE_TEMPLATES`에 대응하는 `STAFF_NOTICE_TEMPLATES` 신설.
- 액션별 4종(출근/퇴근/외출/귀원). 변수: 이름·시각.
- fallback_text(SMS): `"○○○ 선생님, 출근 처리되었습니다. (08:55)"` 형식.
- 카카오 템플릿 승인은 원장님 몫(수일). **승인 전엔 `template_code`가 PENDING이라
  알림톡이 실패 → SMS fallback으로 우선 작동**한다.

### 5. 엣지 케이스
- 알림번호 미지정 → 알림 생략(기록만).
- 직원엔 지각 개념 없음 → 시각만 표시.
- 멱등(20초 내 연타) → 알림 중복 발송 안 함(`last_event` window 재사용).

## 테스트
- `staffCheckinHandler`: 번호 있음→큐 1건 적재, 없음→미적재, 어느 경우든 처리 성공 유지,
  duplicate→미적재.
- 템플릿 변수 치환·fallback_text 포맷.
- HR 폼: 빠른추가/수정 저장이 staff 문서에 반영.

## 배포 주의
- impact7DB `functions:shared` 배포(라이브 백엔드).
- impact7HR 배포.
- `@impact7/shared` 변경은 없을 전망(있으면 태그 배포·의존 lock 갱신).
- 카카오 알림톡 템플릿 승인은 사용자(비즈니스 채널) 몫 — 승인 전에는 SMS로 동작.
