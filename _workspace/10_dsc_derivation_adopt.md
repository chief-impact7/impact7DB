# 10. DSC 내신/자유학기 파생 로직 공유 모듈 교체 (구현 보고)

작업: impact7newDSC가 내신/자유학기 enrollment 파생을 공유 모듈
`@impact7/shared/enrollment-derivation`(v1.7.0)으로 사용하도록 동작 보존 리팩토링.
목적: DB·DSC가 같은 파생 로직을 공유해 불일치 제거.

상태: 완료. 빌드 성공. **커밋·푸시 안 함(보고만).**

---

## 변경 파일

| 파일 | 변경 | 비고 |
|------|------|------|
| `package.json` | `@impact7/shared` `#v1.6.0` → `#v1.7.0` | 13행 |
| `package-lock.json` | resolved commit `b18a1f35…`(v1.6.0) → `5f14fbad…`(v1.7.0), dep 라인 `#v1.7.0` | 1535~1538, 11행 |
| `student-helpers.js` | import 추가 + inline 파생 블록 제거 → 공유 함수 호출 | -64줄 순감 |

경로(절대):
- `/Users/jongsooyi/projects/impact7newDSC/package.json`
- `/Users/jongsooyi/projects/impact7newDSC/package-lock.json`
- `/Users/jongsooyi/projects/impact7newDSC/student-helpers.js`

### lockfile 갱신 (v1.4.0 bump 때와 동일 함정)
`npm install`만으로는 git 의존성이 재해석되지 않아 v1.6.0이 그대로 남았다
(`npm install` 출력 "up to date", node_modules에 `enrollment-derivation.js` 없음 확인).
`rm -rf node_modules/@impact7/shared && npm install @impact7/shared`로 강제 재설치하여
commit hash를 v1.7.0 태그(`5f14fbad7ab6dbf1ff2cbde3c02c1bdfadc35b57`)로 갱신했다.
설치 후: `node_modules/@impact7/shared/package.json` version 1.7.0,
`enrollment-derivation.js`(3537B) 존재, exports에 `./enrollment-derivation` 등록 확인.

---

## student-helpers.js 변경 상세

**import 추가 (6행):**
```js
import { applyNaesinFreeDerivation } from '@impact7/shared/enrollment-derivation';
```

**날짜 필터링은 그대로 유지** (`current` 계산, 기존 178~185행). 변경 없음.

**제거한 inline 블록 (기존 187~249행, 약 63줄):**
- `regularEnroll` 탐색
- 내신 파생 IIFE `activeNaesinEnrollment` (explicit 내신 + override→class_settings naesin 기간 파생, 파생객체 생성, 활성 시 nonRegular만 남기고 정규 숨김)
- 자유학기 파생 IIFE `activeFreeEnrollment` (explicit 자유학기 + 정규 반코드 class_settings free 기간 파생, 활성 시 같은 반코드 정규 숨김)
- 패스스루 `return current`

**교체 후 (188~195행):**
```js
return applyNaesinFreeDerivation(current, {
    classSettings: state.classSettings,
    dateStr: today,
    resolveNaesinCsKey: (re) => resolveNaesinCsKey(s, re),
    enrollmentCode,
});
```
- `resolveNaesinCsKey`, `enrollmentCode`, `state.classSettings`는 기존 그대로 사용.
- DSC의 `resolveNaesinCsKey(s, regularEnroll)`는 2-인자 → 공유 함수의 1-인자
  resolver 시그니처에 맞춰 `(re) => resolveNaesinCsKey(s, re)` 클로저로 주입(학생 `s` 캡처).

---

## 동작 보존 검증

공유 함수(v1.7.0 `enrollment-derivation.js`)는 기존 inline 로직을 라인 단위로 동일하게
옮긴 것임을 코드 대조로 확인:
- 내신 블록: `regularEnroll` 탐색식, explicit 내신 조건, csKey resolve, class_settings
  naesin 기간 검사, 파생객체 필드/순서, nonRegular 필터 — 모두 일치.
- 자유학기 블록: explicit 자유학기 조건, `enrollmentCode(regularEnroll)`로 free csKey,
  free 기간 검사, 파생객체, 같은 반코드 정규 제외 필터 — 모두 일치.
- 패스스루 `return current` 동일.
- DSC는 `state.classSettings[csKey]`를 직접 인덱싱했고, 공유는 `(classSettings||{})[csKey]`.
  주입값이 `state.classSettings`(항상 객체)이므로 `||{}` fallback은 결과에 영향 없음.

### 검증 1 — 공유 모듈 자체 테스트 (v1.7.0 동봉)
`enrollment-derivation.test.js` 8개 케이스 전부 pass
(명시적 내신, override 파생 내신, 내신기간 비활성, class_settings 누락,
override 빈문자열 배제, 자유학기 파생, 내신>자유학기 우선, 정규 없음 패스스루).

### 검증 2 — Differential 테스트 (inline vs 공유, deepEqual)
git HEAD의 기존 inline 로직을 참조 구현으로 추출하고, 동일 입력 14개 시나리오에 대해
`assert.deepEqual(공유결과, inline결과)` → **14/14 동일**:
- 명시적 내신(start 도달 / start 미래→파생 안 함)
- override 파생 내신(기간 활성 / 비활성)
- 자동 유도 내신(resolver가 csKey 반환, 기간 활성)
- override 빈문자열(명시적 배제)
- 자유학기 파생(기간 활성 / 비활성)
- 내신>자유학기 우선
- 정규+특강(특강 보존), 정규 없음(특강만)→그대로
- class_type='자유학기' enrollment가 regularEnroll로 잡혀 free 파생
- 빈 입력, 명시적 자유학기(start 도달)

(differential 스크립트: `/tmp/diff-derivation-test.mjs`, 참조 inline: `/tmp/student-helpers-old.js`)

### 검증 3 — 기존 프로젝트 테스트 회귀 없음
`npm test` (consultation-filter / consultation-payload) 19/19 pass.

### 검증 4 — 빌드
`npm run build` 성공. 747 modules transformed, 4.63s.
(500kB 청크 경고는 기존부터 존재하던 코드분할 권고로 이번 변경과 무관.)

---

## 주의 — 작업 범위 밖 변경 감지

작업 시작 시 `git status` clean이었으나, 종료 시 `student-detail.js`가 modified 상태로
존재함. diff 내용은 성적 표시 관련(`scoreHalfNum`/`reportScoreValue`/`departmentTotalPoints`,
소수점 0.5 반올림·만점 환산 표시)으로 **이번 파생 리팩토링과 무관한 별개 기능**이며,
본 작업에서 건드리지 않음(그대로 둠). 커밋 시 이 파일이 의도된 변경인지 별도 확인 필요.

DSC 커밋 대상(본 작업): `package.json`, `package-lock.json`, `student-helpers.js` 3개.
`student-detail.js`는 본 작업 산출물 아님.

---

## DB 쪽 후속 (참고)
DB도 동일 공유 함수를 채택하면 내신/자유학기 파생이 양쪽에서 단일 소스로 수렴한다.
공유 모듈의 resolver 시그니처는 1-인자(`resolveNaesinCsKey(regularEnroll)`),
DSC는 학생 캡처용 2-인자라 클로저로 어댑트. DB도 자기 resolver를 동일 방식으로 주입하면 됨.
