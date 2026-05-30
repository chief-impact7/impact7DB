# 31. 구 `school` 미러 필드 삭제 안전성 Audit (read-only)

- 일자: 2026-05-30
- 모드: **읽기 전용**. `students`에 write/delete 없음 (`collection().get()`만 사용).
- 스크립트: `_workspace/audit-school-delete-safety.mjs` (마이그레이션 SA 재사용: `service-account.json`, projectId `impact7db`).
- 목적: 단일 `school`(미러) 삭제 시 정보 손실 0인지 검증. `school` 값이 학부별 필드(`school_elementary`/`school_middle`/`school_high`) 중 하나와 정확 일치하면 사본 → 삭제 안전, 어디에도 없으면 손실 → 위험.

## 판정 로직 (학생별)
1. `v = (school || '').trim()`
2. `v === ''` → **안전: empty**
3. `v !== ''` & `v`가 `school_elementary/middle/high` 셋 중 하나와 정확 일치 → **안전: 사본**
4. 그 외(셋 어디에도 `v` 없음) → **위험: 손실**

## 3분류 집계 (전체 15,675건)

| 분류 | 건수 | 비율 | 삭제 영향 |
|------|------|------|-----------|
| 전체 students | 15,675 | 100% | — |
| 안전: empty | 272 | 1.7% | 손실 없음 (애초에 값 없음) |
| 안전: 사본 | 15,365 | 98.0% | 손실 없음 (학부필드에 보존) |
| **위험: 손실** | **38** | **0.24%** | 삭제 시 `school` 값 소실 |

## 위험(손실) 38건 상세

### status 분류
| status | 건수 |
|--------|------|
| 퇴원 | 37 |
| 상담 | 1 |

**활성(재원·등원예정) 위험: 0건.** 위험 건은 전원 퇴원(37) + 상담(1)으로, 운영 중인 활성 학생의 손실은 없다.

### 위험 원인 추정
| 원인 | 건수 |
|------|------|
| 학부필드 3개 전부 빔 (백필 누락) | 38 |
| 현재 level 필드만 빔, 다른 학부필드엔 값 (진급 stale) | 0 |
| 학부필드 값 존재하나 school과 불일치 (깨짐/stale) | 0 |

**38건 전부 `level`이 비어 있고 `school_*` 학부필드 3개가 모두 공란.** `school` 값 자체가 깨진/잘린 문자열(예: `고등학`, `초`, `중`, `유치`, `크리스천스`, `숭실고자`)이라 학부 분류 자체가 불가능했던 레거시·테스트성 레코드다. 정상 학교명이 학부필드 백필에서 누락된 케이스는 0.

### 샘플 15건 (name | school | e/m/h)
```
[퇴원/]  강동진    | school="고등학"     | e="" m="" h=""
[퇴원/]  김건우    | school="고등학"     | e="" m="" h=""
[퇴원/]  김나경    | school="고등학"     | e="" m="" h=""
[퇴원/]  김대현    | school="고등학"     | e="" m="" h=""
[퇴원/]  김선우    | school="고등학"     | e="" m="" h=""
[퇴원/]  김수현    | school="고등학"     | e="" m="" h=""
[퇴원/]  김시명    | school="고등학"     | e="" m="" h=""
[퇴원/]  김시현200 | school="초"        | e="" m="" h=""
[퇴원/]  김영운    | school="고등학"     | e="" m="" h=""
[퇴원/]  김영찬동생 | school="중"        | e="" m="" h=""
[퇴원/]  김주영    | school="고등학"     | e="" m="" h=""
[퇴원/]  맹서인    | school="크리스천스" | e="" m="" h=""
[퇴원/]  박규빈    | school="유치"      | e="" m="" h=""
[퇴원/]  박도언    | school="숭실고자"   | e="" m="" h=""
[퇴원/]  박준서204 | school="고등학"     | e="" m="" h=""
```
모든 `school` 값이 잘린/비정상 문자열이며 `level`·학부필드가 공란 — 정보 가치가 사실상 없는 손상 데이터.

## 게이트 판정

- 위험(손실) **38건 / 활성 0건**.
- 위험 38건은 전원 퇴원(37)·상담(1)이며, 값 자체가 깨진/잘린 레거시 데이터(정상 학교명 백필 누락 0건).
- **활성 손실이 핵심인데 0건이므로, 활성 데이터 기준 전수 삭제는 안전.**
- 위험 38건은 (a) 깨진 값이라 백필해도 의미 없음, (b) 전원 비활성(퇴원/상담) → **손실 허용 판단 가능.** 별도 백필 없이 삭제 진행해도 운영 영향 없음.
- 보존을 원하면 삭제 직전 위험 38건만 `school` 원값을 history_logs/별도 백업 컬렉션에 스냅샷 후 삭제 (백필 방안: 학부필드로 옮길 정상값이 없으므로 백필이 아니라 "원값 아카이브"가 적절).

## 삭제 배치 방식 권고

- **방식:** `admin.firestore.FieldValue.deleteField()`로 `school` 키만 제거. 다른 필드 무변경.
  ```js
  batch.update(ref, { school: admin.firestore.FieldValue.deleteField() });
  ```
- **대상:** `school`이 존재하는 전 건(empty 272 + 사본 15,365 + 위험 38 — 단, empty는 `''`라도 키가 있으면 포함). 사본 15,365건은 학부필드에 보존되어 무손실.
- **배치 크기:** 200건/배치, 순차 commit (스크립트 기존 패턴과 동일).
- **사용자 승인 필수:** 대량 Firestore 배치는 승인 후 실행 (2026-03-17 47M reads 사고 교훈). 이 audit은 read-only이며 삭제는 미실행.

## 트리거 영향 (onStudentLabelSync)

- 위치: `functions-shared/index.js` → `onStudentLabelSync` (`onDocumentWritten('students/{docId}')`).
- 로직: `after` 데이터로 `computeLabelUpdate()` 호출. `school_level_grade` 라벨이 **변경될 때만** `after.ref.update(update)` 실행. 동일하면 `return null`로 write 스킵 → 무한루프 방지.
- `computeLabelUpdate`(`functions-shared/src/studentLabelSync.js`): `school_*` 학부필드 유무로 가드하고 `studentFullLabel()`로 라벨 산출. **`school` 미러를 읽지 않음.**
- `studentFullLabel`(`@impact7/shared/student-label`): 라벨의 학교명을 `student[SCHOOL_FIELD[predLevel]]`(= `school_elementary/middle/high`)에서만 가져옴. **`school` 미러 미참조.**

**결론:** `school` 키 삭제 write가 트리거를 재발화시키지만, `school_level_grade`는 학부필드 기반이라 라벨이 무변경 → `computeLabelUpdate`가 `null` 반환 → 추가 write 없음. **무한루프·대량 재write 없음.** 트리거는 docId당 1회 재발화 후 즉시 종료(읽기 1 + 산출, write 0).

- 단, 위험 38건은 `school_*` 전부 공란이라 `computeLabelUpdate`가 `hasAnySchool=false`로 즉시 `null` 반환(라벨 미산출). 무영향.

---

## 게이트 판정 요약

- **위험(손실) 38건, 활성(재원·등원예정) 0건.** 위험 38건은 전원 퇴원(37)·상담(1)이며 값 자체가 깨진/잘린 레거시 데이터(정상 학교명 백필 누락 0).
- 활성 손실 0 → **활성 기준 전수 삭제 안전.** 사본 15,365건은 학부필드에 무손실 보존됨.
- 위험 38건은 백필할 정상값이 없고 전원 비활성이라 **손실 허용 판단 가능**(보존 원하면 삭제 전 원값을 백업 컬렉션에 스냅샷).
- 삭제 방식: `deleteField()`로 `school` 키만 제거, 200건/배치, **사용자 승인 후 실행**. 트리거 `onStudentLabelSync`는 라벨 무변경이라 재write·무한루프 없음.
