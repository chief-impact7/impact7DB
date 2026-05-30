# 34. DSC 검색어 shared 교체 (전역 전환 잔여 2번)

분석: `30_search_terms_shared_analysis.md` §6 (4단계: DSC). 동작 무변화(이미 studentFullLabel 기반).

## 변경 지점
| 파일 | 변경 |
|------|------|
| `impact7newDSC/package.json:13` | `@impact7/shared` `#v1.15.0` → `#v1.16.0` |
| `impact7newDSC/package-lock.json:1536` | resolved 커밋 `9df285a`(v1.15.0) → `1ab5025`(v1.16.0) |
| `impact7newDSC/school-normalizer.js` | 로컬 `schoolSearchTerms`(25줄) → shared 재노출 1줄 |

교체 후 `school-normalizer.js` 전문:
```js
export { studentSearchTerms as schoolSearchTerms } from '@impact7/shared/student-label';
```
(주석 제외 본문 1줄. DSC `school-normalizer.js`는 이 함수 단독 export였으므로 유지할 다른 export 없음.)

## bump / 캐시 이슈
- npm github 의존 캐시 재사용 발생: 1차 `npm install` 후 lock 문자열은 `#v1.16.0`이나 resolved 커밋이 v1.15.0(`9df285a`)에 고정 → 설치된 `student-label.js`에 `studentSearchTerms` **부재**.
- `rm -rf node_modules/@impact7/shared` + `npm install @impact7/shared@github:...#v1.16.0` 강제 재설치로 resolved를 v1.16.0 태그 커밋(`1ab5025`)으로 교정 → `studentSearchTerms` 존재 확인 완료.
- 원격 태그 대조: `v1.16.0` → `1ab5025`, `v1.15.0` → `9df285a` (git ls-remote 확인).

## 4 callsite 무수정 확인
모두 `import { schoolSearchTerms } from './school-normalizer.js'` (이름 import). 재노출 시 이름 보존 → 무수정.
| callsite | 소비 형태 |
|----------|----------|
| `class-student-search.js:72` | `schoolSearchTerms(s).map(t=>t.toLowerCase())` |
| `role-memo.js:362` | `.some(t=>t.toLowerCase().includes(qLower))` |
| `leave-request.js:584` | `.some(t=>t.toLowerCase().includes(termLower))` |
| `class-setup.js:870` | `.map(t=>t.toLowerCase())` |
재노출이 동일 import 경로로 해석됨을 런타임 확인(`신목 중2`→`["신목","신목중","신목중2"]`).

## 동작 무변화 검증
shared `studentSearchTerms` vs 로컬 `schoolSearchTerms` 표본 비교(6케이스):
- 일치 5케이스: `신목 중2`→`["신목","신목중","신목중2"]`, `진명여자고등학교 고1`→`["진명여","진명여고","진명여고1"]`, 빈학교 중2→`["중2"]`, `서울봉영여중1`, `서초 중2`.
- 졸업 케이스만 형식 차: shared `["서울대일","서울대일고"]`(Set 중복제거) vs 로컬 `[…,"서울대일고","서울대일고"]`(중복 잔존). **매칭 관련 내용 동일**, 차이는 redundant 중복 항목뿐 → 4 callsite 모두 membership/substring 검사라 무영향. **callsite 동작 무변화.**

## 빌드/테스트
- Vite build: 748 modules transformed, ✓ built (exit 0).
- `npm test`: tests 19, pass 19, fail 0.

## 제약 준수
커밋·푸시·배포 안 함. shared repo 무수정(읽기만). `/simplify` 불요(이미 1줄 재노출, 커밋 전 단계).
