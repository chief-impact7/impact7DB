# 11. DB 내신/자유학기 파생 공유 모듈 도입 (구현 보고)

날짜: 2026-05-28
대상: impact7DB
공유 모듈: `@impact7/shared/enrollment-derivation` (v1.7.0)
상태: 구현 완료, **커밋·푸시 안 함** (보고만)

---

## 배경 / 갭

기존 DB의 `getActiveEnrollments`는 **명시적 `class_type:'내신'` enrollment**만 정규를 억제했다.
`naesin_class_override` 문자열 + `class_settings` 기간 기반 파생을 하지 않아,
override만 있는 학생(예: 김민주4)이 DB에선 정규로, DSC에선 내신으로 갈렸다.
이번 작업으로 이 갭을 공유 모듈로 제거했다.

---

## 변경 파일·라인

### 1) `package.json`
- L24: `@impact7/shared` 의존성 `#v1.6.0` → **`#v1.7.0`**
- `npm install` 실행. npm이 git 태그를 캐시하고 있어 `npm cache clean --force` +
  `node_modules/@impact7` 삭제 후 재설치로 v1.7.0(파일 `enrollment-derivation.js`) 반영 확인.
- `package-lock.json`: `@impact7/shared` version `1.7.0`, resolved commit `5f14fba…`로 갱신됨.

### 2) `app.js`

| 라인(변경 후) | 내용 |
|------|------|
| L11 | `import { applyNaesinFreeDerivation } from '@impact7/shared/enrollment-derivation';` 추가 |
| L17~33 | `_classSettingsCache` 모듈 캐시 + `async loadClassSettings()` 헬퍼 신설 (상단으로 끌어올림) |
| L300~314 | `getActiveEnrollments` — 명시적 내신만 보던 블록(기존 287~294) **제거**, `applyNaesinFreeDerivation` 호출로 교체 |
| L521~525 | `loadStudentList` 내 첫 렌더 전 `await loadClassSettings()` 추가 (eager-load) |
| L5290~5301 | 모달 `_populateTargetClassDropdown`의 인라인 lazy `getDocs` 블록을 `loadClassSettings()` 재사용으로 단순화 |

기존 그룹핑·날짜필터(`current` 계산), `relevantEnrollments`의 semester 필터 분기는 **그대로 유지**.

---

## class_settings eager-load 구현 방식

- 모듈 상단에 `let _classSettingsCache = null` + `async function loadClassSettings()`를 신설.
  `getDocs(collection(db,'class_settings'))` 1회로 `{ [docId]: data }` 맵을 채운다(실패 시 빈 맵 fallback).
- **로드 시점:** `loadStudentList()`에서 `allStudents` 적재·`storeUpdate` 직후, 그리고
  `promoteEnrollPending()` / `handleScheduled*()` / 렌더 체인(`loadMemoCacheAndRender` → `applyFilterAndRender`) **이전**에
  `await loadClassSettings()`를 호출.
  → 첫 리스트 렌더 시점에 캐시가 반드시 채워져 있어 파생이 동작한다(미로드면 조용히 정규로 보이는 문제 방지).
- **캐시 통합:** 기존 모달 전용 `_classSettingsCache`(lazy, line ~5272)를 제거하고 상단 캐시로 일원화.
  모달은 `if (!_classSettingsCache) await loadClassSettings()`로 안전 폴백(로그인 흐름 외 진입 대비).
  결과적으로 컬렉션은 1회만 로드(반당 1문서 소형 컬렉션, reads 부담 없음).
- `getActiveEnrollments`는 `classSettings: _classSettingsCache || {}`를 주입 — 미로드(null) 시 빈 객체로 파생 없이 동작(안전).

## getActiveEnrollments 호출 형태

```js
return applyNaesinFreeDerivation(current, {
  classSettings: _classSettingsCache || {},
  dateStr: today,
  resolveNaesinCsKey: (re) =>
    (typeof re.naesin_class_override === 'string' ? (re.naesin_class_override || null) : null),
  enrollmentCode,
});
```
- `resolveNaesinCsKey`는 **override-only**: 문자열이면 그 값(빈 문자열은 null), 그 외 null. DB는 자동유도 없음.
- `enrollmentCode`는 app.js 기존 export(`(e) => level_symbol+class_number`) 사용.

---

## 김민주4 파생 확인 방법

데이터(프로덕션): 정규 enrollment(코드 HX104) + `naesin_class_override='2단지선유고2B'`,
class_settings 문서 `'2단지선유고2B'`에 `naesin_start≈5/14`, `naesin_end≈7/3` (오늘 5/28 활성).

공유 함수 추적:
1. `regularEnroll` = 정규 HX104 탐지.
2. `resolveNaesinCsKey(regularEnroll)` → `'2단지선유고2B'`.
3. `classSettings['2단지선유고2B']`의 `naesin_start ≤ 오늘 ≤ naesin_end` → 활성.
4. 파생된 `class_type:'내신', class_number:'2단지선유고2B'` enrollment 반환, **정규 HX104 숨김**.

수동 확인 절차(브라우저):
- 학원 계정 로그인 → 학생 목록에서 김민주4 검색.
- 리스트 카드의 반코드가 **HX104(정규)가 아닌 내신(2단지선유고2B)**으로 표시되는지 확인.
- 상세 패널 진입 시에도 활성 enrollment가 내신으로 나오는지 확인.
- (선행조건) class_settings가 렌더 전에 로드돼야 하므로, 콘솔에서
  `Object.keys(_classSettingsCache).length > 0`이 첫 렌더 이전에 충족됨 — eager-load로 보장.

빠른 콘솔 검증(로그인 후):
```js
const s = allStudents.find(x => x.name === '김민주4'); // 동명이인이면 id로 특정
getActiveEnrollments(s).map(e => `${e.class_type} ${enrollmentCode(e)}`);
// 기대: ["내신 2단지선유고2B"] (정규 HX104 미포함)
```
주의: `getActiveEnrollments`/`allStudents`가 window 노출이 아니면 콘솔에선 UI 표시로 확인.

---

## 빌드 결과

`npx vite build` 성공.
- 34 modules transformed, built in ~1.5s.
- `dist/assets/index-*.js` 517.57 kB (gzip 155.72 kB).
- 경고: 단일 청크 500kB 초과(기존부터 있던 경고, 본 변경과 무관). import 오류 없음 → enrollment-derivation 정상 번들.

---

## 후속 메모

- 본 변경은 DB 신규 동작(파생) 도입이므로 배포 전 김민주4 등 override-only 학생 1~2건 수동 확인 권장.
- `naesin_class_override`는 DSC가 enrollment에 기록하는 데이터 필드(DB는 read-only로만 사용).
- 커밋·푸시 미실행. 승인 후 `simplify`/`code-review` 절차는 본 보고 시점에 simplify 완료(추가 정리 불필요), commit 단계에서 code-review 권장.
