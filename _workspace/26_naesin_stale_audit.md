# 26. 내신 csKey 이전 — Phase 0 stale audit (조회 전용)

작성: 2026-05-30 · 상태: **READ ONLY 완료 (students write 0건)**
범위: 블로커 ②(구 `school` 미러 제거 후속 1번) 동시 이전의 **사전 게이트**
근거: `_workspace/25`, `@impact7/shared/student-label.js`, DSC `student-helpers.js`, DB `functions/src/naesinHelpers.js`, `migrate-school-by-level.js`(SA 재사용)
스크립트: `_workspace/audit-naesin-stale.mjs`, `_workspace/audit-naesin-stale-verify.mjs` (둘 다 `collection('students').get()` 만 — write 없음)

---

## 0. 게이트 결론 (먼저)

**활성 내신 stale = 0 / 실제 키변동 = 0 → 무중단 동시 이전 가능 (백필 불요).**

`.school → currentSchool(student)` 치환으로 csKey가 실제로 바뀌는 **활성 내신 대상 학생은 0건**이다. 따라서 분석 25 §5의 무중단 전제("정상 학생 `.school == currentSchool`")가 현 데이터에서 충족됨이 실측으로 확인됐다.

---

## 1. 활성 내신 집합 정의 (게이트 모집단) · 근거

게이트 판정은 **(b) 활성 내신 대상**에서만 의미가 있다. cleanup·daily log·class_settings 매칭은 활성 학생 enrollment로만 키를 재생성하기 때문(분석 25 §2~4).

**(b) 활성 내신 대상 정의:**
- **status ∈ {재원, 등원예정}** — 휴원(가휴원/실휴원)·퇴원·상담 제외.
  - 근거: DSC `student-helpers.js`의 `NON_LEAVE_ACTIVE`/`isOnLeaveAt`/`isWithdrawnAt`. 휴원·퇴원은 출결/편성에서 숨겨져 cleanup의 활성 카운트에 안 들어가고, daily log 내신 그룹에도 안 잡힘. 보수적으로 재원 계열만 게이트 모집단에 포함.
- **AND 내신 키가 실제로 산출되는 학생**: 다음 중 하나
  - `resolveNaesinCsKey`가 non-null (정규/자유학기 enrollment 보유 + `deriveNaesinCode`가 school+grade로 키 생성, 또는 `naesin_class_override` 보유), 또는
  - `class_type === '내신'` enrollment 직접 보유.
  - 근거: `deriveNaesinCode`(`student.school`·grade 없으면 `''` 반환 → 내신 매칭 자체 탈락), `resolveNaesinCsKey`(override='' 센티넬은 명시적 배제 → null).

이 정의로 집계된 활성 내신 대상 = **341명**.

**(a) 전체 students** = 15,675건 (게이트 아님, 참고 집계).

---

## 2. 집계 결과

| 집합 | 건수 |
|------|------|
| (a) 전체 students | **15,675** |
| 전체 stale(`.school != currentSchool` 또는 현재 학부 `school_*` 누락) | **110** |
| (b) 활성 내신 대상(status 재원/등원예정 + 내신 키 가능) | **341** |
| **(b) 활성 내신 stale** | **0** |
| **(b) 활성 내신 실제 csKey 변동(old≠new)** | **0** |
| 활성 내신 stale이지만 override로 키 보존 | 0 |

**교차검증(verify 스크립트):** 전체 stale 110건의 **status 분포 = 퇴원 109 + 상담 1**. status=재원/등원예정 이면서 stale인 학생은 **0건**(내신 대상 여부와 무관하게 0). 즉 stale은 전부 비활성 데이터에 갇혀 있다.

---

## 3. 원인 분류 (전체 stale 110건)

활성 내신 stale이 0이라 게이트 관점 원인 분류는 공집합이다. 전체 110건(전원 비활성)의 성격:

| 분류 | 성격 | 비고 |
|------|------|------|
| **현재 학부 `school_*` 누락** (`miss=true`) | 퇴원생 다수, level은 있으나 `school_elementary/middle/high` 미작성 → `currentSchool=''` | 예: `ㅇㅇ/강단우/강보민`(초·고/퇴원). `.school`도 대개 `''` |
| **level 누락 + `.school` 잔재** (`miss=false`, cur=`''`) | `level` 필드 없음 → `SCHOOL_FIELD[undefined]=undefined` → `currentSchool=''`, 그러나 `.school`="고등학"류 잔재 보유 | 예: `강동진/김건우/김나경`. `.school != ''` 이라 mismatch=true. 구 데이터 파편 |
| **상담 1건** | 상담 상태 stale | 게이트 비대상(활성 아님) |

→ **모두 퇴원·상담 등 비활성 레코드의 데이터 파편**이며, 내신 키 매칭 경로(cleanup/daily log/class_settings)에 진입하지 않는다. 진급 미러 지연·newtest 미마이그레이션 등 **활성 학생에서 발생하는 위험 케이스는 현재 0건**.

---

## 4. csKey 실제 영향 표본 (보존 확인)

활성 내신 학생은 `.school == currentSchool` 이라 old/new 키가 동일하다. 표본:

| 학생 | `.school` | `currentSchool` | csKey(old=.school) | csKey(new=currentSchool) | 동일? |
|------|----------|-----------------|--------------------|--------------------------|-------|
| 강건 | 대일 | 대일 | `2단지대일고1B` | `2단지대일고1B` | ✅ |
| 강민재 | 신남 | 신남 | `10단지신남중1B` | `10단지신남중1B` | ✅ |
| 강서연 | 신목 | 신목 | `2단지신목중2B` | `2단지신목중2B` | ✅ |

> `.school` 미러가 곧 현재 학부 학교명이라 토큰 치환 후에도 키 글자 단위 동일 → `class_settings/{csKey}` doc id 보존, CF 매칭 무손상. 활성 내신 341명 중 키가 달라지는 표본은 발견되지 않음.

---

## 5. 백필 필요 여부

**백필 불요.** 활성 내신 stale=0이므로 게이트 통과를 위한 선행 백필 작업이 없다.

- 전체 stale 110건은 전원 퇴원/상담(비활성)이라 이전과 무관. 굳이 정리할 필요도 없음(내신 키 경로 미진입).
- 다만 분석 25 §3의 위험 케이스(진급 미러 지연·newtest `school_*` 미작성)는 **상시 재발 가능**하므로, 실제 배포 직전 동일 audit 재실행으로 stale=0을 재확인(게이트 idempotent 점검)하길 권장.

---

## 게이트 판정 (반환)

- **활성 내신 stale = 0 / 실제 csKey 변동 = 0 → 무중단 동시 이전 가능. 백필 선행 불요.** (게이트 통과)
- 전체 students 15,675 중 stale 110건은 **전원 퇴원 109 + 상담 1**(비활성)이라 내신 키 매칭 경로(cleanup·daily log·class_settings)에 진입하지 않음 → 영향 없음. 활성(재원/등원예정) stale은 0건.
- 활성 내신 341명은 `.school == currentSchool`이라 csKey 글자 단위 보존 표본 확인(강건 `2단지대일고1B` 등 old==new).
- 다음 권고: 분석 25 §5의 A(DB functions:leave-request)·B(DB hosting)·C(DSC hosting) **동시 이전 진행 가능**. 단 **실 배포 직전 이 audit을 재실행**해 stale=0 재확인(진급/newtest 발 상시 재발 대비)을 배포 체크리스트에 고정할 것. 키 이전 코드 수정은 다음 태스크(본 태스크 범위 밖).
