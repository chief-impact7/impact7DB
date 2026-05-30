# 진단평가 버그 3종 수정 코드리뷰 (shared v1.18.0 + DB/DSC/newtest)

리뷰 범위: shared `student-label.js`, DB `app.js`, DSC `diagnostic.js`, newtest `cloudrun/src/index.js`. 코드 수정 없음, 발견만 기록.

---

## CRITICAL

### C1. `normalizeSchoolForLabel` — `/[초중고]$/` 가드 제거로 지역명 풀네임 오삭제 (회귀)
`/Users/jongsooyi/projects/impact7-shared/student-label.js:35-43`

기존(HEAD~1)은 지역명 제거 조건이 `rest.length > 1 && /[초중고]$/.test(rest)`였다. 신버전은 `abbrApplied(s===beforeAbbr)` 가드를 추가하면서 `/[초중고]$/` 검사를 **삭제**했다. 그 결과 약어 미적용 + 지역prefix 풀네임에서 지역명이 과도하게 잘린다.

실측 (OLD HEAD~1 → NEW):
| 입력 | OLD | NEW | 문제 |
|------|-----|-----|------|
| 충남삼성고등학교 | 충남삼성고 | **삼성고** | 지역 손실(삼성고는 여러 지역 존재 → 동명 충돌) |
| 대구남산고등학교 | 대구남산고 | **남산고** | 지역 손실 |
| 인천하늘고등학교 | 인천하늘고 | **하늘고** | 지역 손실 |
| 서울대학교사범대학부설고등학교 | 서울대학교사범대학부설고 | **대학교사범대학부설고** | 앞 `서울대` 손실, 의미 깨짐 |
| 강원/경북/전남/부산 …대학교사범대학부설고 | (지역 유지) | **대학교사범대학부설고** | 서로 다른 학교가 **동일 라벨로 충돌** |

`사범대학부설`은 약어표 `사범대부속`(부속≠부설)과 매칭되지 않아 abbrApplied=false → 지역제거 실행 → `서울대학교사범대학부설`에서 `서울` 제거. 구 가드는 stem이 `…설`로 끝나(고/중/초 아님) 우연히 보호했으나, 신버전은 그 보호가 사라짐.

**부작용 범위**: `studentSearchTerms`도 동일 stem을 쓰므로 표시·검색 양쪽에서 동일하게 깨진다(상위 라벨 검색어까지 오염).

수정안(택1):
1. 지역제거 조건에 `/[초중고]$/.test(rest)`를 **복원**(abbrApplied 가드와 AND). `염경중` 류 fix는 이미 `rest`가 `염경`→이후 lv부착이므로 stem이 `초중고`로 안 끝나는데, 그래도 OLD에서 `서울염경`은 stem이 `경`으로 끝나 잘못 처리됐었음 → 이 fix의 핵심 목표(`서울염경중`→`염경중`)와 가드 복원이 양립하는지 재검토 필요. 실제로 `서울염경중학교`는 stem `서울염경`(끝 `경`) → `/[초중고]$/` 실패 → 가드 복원 시 fix가 다시 깨짐.
2. 따라서 권장: `대학교/대학` 등 **다음절 기관어 포함 학교는 지역제거 제외**(예: stem에 `대학` 포함 시 skip), 또는 `사범대학부설`도 약어표에 추가(`사범대학부설`→`사대부`)하여 `대학교사범대학부설`이 약어적용으로 region skip되게 함. 후자가 충돌(서울대부고 vs 강원대부고)을 근본 해소.
3. 최소 안전책: 지역제거 후 `rest.length`가 일정 길이 이상이면(예: stem이 5글자↑로 길면) 풀네임 학교로 보고 제거 skip.

> 핵심 트레이드오프: 목표 fix(`서울염경중`→`염경중`)는 "지역+2글자고유명+학부" 단형에는 맞지만, "지역+대학부설/대학교…" 장형 공식명까지 무차별 적용되어 회귀 발생. 단형/장형을 구분하는 규칙 필요.

---

## MAJOR

### M1. `abbrApplied`(`여자`/`외국어`) 학교의 지역prefix 보존 — 의도 확인 필요
`/Users/jongsooyi/projects/impact7-shared/student-label.js:32-43`

약어 적용 시 지역제거를 전면 skip한다. 결과:
- `서울여자중학교` → `서울여중`(서울 유지)
- `경기외국어고등학교` → `경기외고`
- `봉영여자중학교` → `봉영여중`(지역 아님, 정상)

`서울여중`/`경기외고`는 통용 약칭이라 **현실 데이터상 의도로 보는 게 타당**(고유명처럼 굳음). 단 사용자 의도가 "지역까지 떼서 `여중`/`외고`"라면 과보존. → **약어가 지역명 자체를 만들지 않으므로(`여자`→`여`) abbr 후에도 region-strip을 막을 필요는 논리적으로 없음**. C1 수정에서 `/[초중고]$/` + 단형 가드로 통일하면 `서울여중`은 stem `서울여`(끝 `여`)라 어차피 제거 안 됨 → abbrApplied 분기 자체가 불필요해질 수 있음. abbrApplied 가드의 존재 이유를 재검토 권장(현재는 C1 회귀의 직접 원인이기도 함).

minor 동반: `부속`→`부` 단독 약어도 abbrApplied=true 처리됨(`제주부속중`→`제주부중`, `한국교원대학교부속고`→`한국교원대학교부고`). 후자는 장형이라 어차피 region이 `한국`이 아니라 무해하나, `부` 1글자 약어가 abbrApplied 분기를 켜는 부작용 주의.

---

## MINOR

### m1. DB 필터 — `updated_at`(UTC) vs `first_registered`/cutoff(KST) 날짜 경계 불일치
`/Users/jongsooyi/projects/impact7DB/app.js:1174`

```js
const ts = s.updated_at?.toDate?.()?.toISOString?.()?.slice(0, 10) || s.first_registered || '';
```
`toISOString().slice(0,10)`은 **UTC** 날짜다. 반면 `first_registered`/`start_date`(cutoff)/`withdrawal_date`는 전부 KST(`toDateStrKST`, app.js:874). KST 자정~오전 9시 사이에 갱신된 상담/종강 학생은 UTC 날짜가 전일로 찍혀, cutoff가 그 경계일과 같을 때 하루 어긋나 누락될 수 있다(엣지, 영향 1일·소수). 일관성 위해 `toDateStrKST(s.updated_at.toDate())` 사용 권장. 형식(YYYY-MM-DD 문자열 비교)·타입 호환 자체는 정상.

### m2. DSC `updated_at: serverTimestamp()` 중복 (버그 아님)
`/Users/jongsooyi/projects/impact7newDSC/diagnostic.js:241`

`baseFields.updated_at`을 명시했으나 `auditSet`이 `_auditFields()`로 `updated_at: serverTimestamp()`를 다시 주입한다(audit.js:41,56, spread 순서상 audit 값이 최종). merge(:250)·신규(:256 spread) 양쪽 모두 정상 기록됨. rules 화이트리스트에 `updated_at` 존재(firestore.rules:73), 필드수 ≤ 35 OK. 명시 라인은 **삭제해도 동작 동일**(정리 권장).

---

## 회귀/호환 — 정상 확인된 항목

- **newtest `updated_at: new Date()`**: `firestoreValue`(index.js:158)가 `Date`→`{timestampValue: toISOString()}`로 변환 → Firestore 네이티브 Timestamp 저장 → DB의 `.toDate()`와 **호환**. patch는 `updateMask.fieldPaths = Object.keys(data)`(:198)라 기존 student status/enrollments 보존, 신규는 status='상담' 분기(:613-617) 정상.
- **`currentSchool`/`studentFullLabel` school 폴백**(student-label.js:14,50): students는 학부필드 사용·school 미러 삭제됨 → 학부필드 우선이라 폴백 미발동(무영향). temp_attendance·contacts 등 school만 가진 도메인에서만 폴백 동작 — 의도대로. school_* 없고 school만 남은 잔존 students가 있다면 폴백되나, 미러 삭제 완료분에선 회귀 없음.
- **2글자 지역 + 짧은 학교**: `세종중학교`→`세종중`, `경남중학교`→`경남중` — stem이 지역명과 동일 길이라 `s.length > r.length` false로 제거 skip(정상). `세종고`도 동일.
- **빈 학교**: `중1` 정상(빈값 처리).
- DSC/DB/exam students rules에 `updated_at` 포함, 필드한도 여유 확인.

---

## 심각도별 건수
- CRITICAL: 1 (C1 지역명 풀네임 오삭제 회귀 — 동명충돌·의미손실)
- MAJOR: 1 (M1 abbrApplied 지역보존 의도확인 + abbrApplied 분기 필요성 재검토)
- MINOR: 2 (m1 UTC/KST 경계, m2 updated_at 중복)
- 정상확인: newtest Timestamp 호환, school 폴백, 2글자지역, rules

## 핵심 5줄
1. **C1(critical)**: `/[초중고]$/` 가드 삭제로 `충남삼성고→삼성고`, `서울대학교사범대학부설고→대학교사범대학부설고` 등 지역prefix 풀네임이 과삭제 — 특히 `…대학교사범대학부설고`는 서울/강원/경북 등이 **동일 라벨로 충돌**. 표시·검색 양쪽 오염.
2. 근인: `사범대학부설`이 약어표(`사범대부속`)와 불일치→abbrApplied=false→지역제거 실행. 구 가드(stem이 초중고로 안 끝남)가 우연히 보호하던 걸 잃음.
3. fix 목표(`서울염경중→염경중`)와 가드복원이 충돌하므로, "지역+2글자+학부" 단형만 제거하고 `대학(교)`·`사범대학부설` 장형은 제외(또는 약어표 추가)하는 분기가 필요.
4. **M1(major)**: abbrApplied 시 region skip은 `서울여중`엔 맞지만 분기 자체가 C1 회귀의 원인 — 단형 가드로 통일하면 abbrApplied 분기 제거 가능성 검토.
5. **나머지 정상**: newtest `new Date()`→timestampValue→DB `.toDate()` 호환 OK, DSC updated_at은 auditSet 중복(무해), school 폴백 무영향. m1(UTC/KST 1일 경계)만 일관성 개선 권장.
