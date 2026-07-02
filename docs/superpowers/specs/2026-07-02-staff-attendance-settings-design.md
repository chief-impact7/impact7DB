# 직원 근태 설정(하루 경계·자동 출퇴근) 설계

**목표:** 하드코드된 하루 경계(06:00)와 자동 퇴근 시각(22:30)을 personnel에서 설정하게 하고,
자동 출근/퇴근 시각을 전체/부서별/직원별로 지정한다. 입력이 있을 때만 자동 처리한다.

## config 스키마 — Firestore `settings/staff_attendance` (단일 문서)
```
{
  dayStartHour: 6,                 // 하루(근무일) 경계 시각, 전체 공통. businessDayKST cutoffHour.
  autoClockOut: {                  // 미퇴근 시 자동 퇴근 시각. 'HH:mm' 또는 null/'' = 자동 없음.
    global: '22:30',
    byDept:  { '교수': '23:00', ... },
    byStaff: { '<staffId>': '22:00', ... },
  },
  autoClockIn: {                   // 미출근 시 자동 출근 시각. 'HH:mm' 또는 null/'' = 자동 없음.
    global: null,
    byDept:  { ... },
    byStaff: { ... },
  },
}
```
- **우선순위(시각 해석):** `byStaff[id] ?? byDept[dept] ?? global ?? null`. 필드별 독립 오버라이드.
- `resolveAutoTime(kind, staffId, dept, settings)` → `'HH:mm' | null` 순수 함수(shared 또는 functions-shared).

## 하루 경계 적용
- `staffCheckinHandler`: 트랜잭션 밖에서 settings 1건 get → `businessDayKST(new Date(), settings.dayStartHour ?? 6)`. settings 없거나 오류면 기본 6.
- 하루 경계는 date 문서 경계라 **전체 공통만**(직원별 경계는 문서 충돌로 배제 — 사용자 합의).

## 자동 퇴근 (기존 staffAutoClockout 확장)
- 스케줄: 매일 KST `dayStartHour`시(=하루 경계, 기본 06:00). 전날 근무일(businessDay) 미퇴근(IN·OUT) 직원 대상.
- 각 직원 `resolveAutoTime('out', staffId, dept, settings)`:
  - 시각 있으면 → 전날 그 시각(KST)으로 퇴근 기록.
  - null이면 → **자동 퇴근 안 함**(그대로 미퇴근 유지).
- 기존 22:30 하드코드 제거 → config 값.

## 자동 출근 (신규 staffAutoClockin)
- 스케줄: 매일 KST `dayStartHour`시. 전날 근무일에 **출근 기록이 없는**(staff_attendance 문서 없음 or state=미등원) active 직원 중, `resolveAutoTime('in', ...)` 시각이 설정된 직원만 → 전날 그 시각 출근 기록 생성.
- 시각 null이면 처리 안 함(대다수 직원은 미설정 → 영향 없음).
- 멱등: 이미 문서 있으면 스킵.

## HR UI (personnel)
- 별도 "근태 설정" 섹션/모달: dayStartHour(시각), 자동 퇴근/출근의 global·부서별·직원별 입력('HH:mm', 빈 값=없음).
- 저장 → `settings/staff_attendance` 문서 갱신(callable 또는 직접 write + rules).

## 보안/규칙
- `settings/staff_attendance`: 매니저 이상 read/write. firestore.rules 추가.

## 테스트
- resolveAutoTime 우선순위(staff>dept>global, null 폴백).
- 자동 퇴근/출근: 시각 설정 시 기록, null 시 스킵, 멱등.
- businessDayKST(now, dayStartHour) 경계.

## 배포 주의
- functions:shared + firestore:rules(settings 규칙) + firestore:indexes(자동 출근 쿼리).
- HR 배포.
- invoker 자동복구(CI)로 재배포 커버.
