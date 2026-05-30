# 52. DB 학생 표시 studentFullLabel 통일

## 변경 지점
- **app.js** L348-362 `abbreviateSchool`: 내부 로직(cleanSchoolName·levelShortName·LEVEL_MAX_GRADE·NEXT_LEVEL grade 정규화) 제거 → `const abbreviateSchool = (s) => studentFullLabel(s) || '—';`. 사용처 4곳(1502·1586·1898·1924) 호출 무변경. `studentFullLabel`는 L13에서 이미 import 중.
- **naesin-schedule.js** L23 `abbreviateSchool` → `const abbreviateSchool = (s) => studentFullLabel(s) || '';` (fallback '' 유지). `buildNaesinGroups` label(L71) 호출 무변경.
- **package.json**: `@impact7/shared` `#v1.20.0` → `#v1.21.0`.

## 미사용 import 정리
- app.js: `levelShortName` import 제거 (school-normalizer.js import 라인). `cleanSchoolName`은 3817·3851·3883에서 사용 → 유지. `LEVEL_MAX_GRADE`·`NEXT_LEVEL`은 app.js 로컬 const이며 4897·4904·6370~6374·6371에서 사용 → 유지.
- naesin-schedule.js: `cleanSchoolName`·`levelShortName` import 제거(다른 사용 없음), `LEVEL_MAX_GRADE`·`NEXT_LEVEL` 로컬 const 제거(다른 사용 없음). `studentFullLabel`은 기존 `currentSchool` import에 추가.

## shared v1.21.0 설치
- package-lock.json이 구 commit(16a201b=v1.20.0)을 pin하고 있어 npm이 git 캐시 재사용 → lock의 resolved를 v1.21.0 commit(b30441b)로 갱신 후 node_modules/@impact7/shared 삭제+재설치.
- 검증: `grep -c REGION_KEEP_EXACT node_modules/@impact7/shared/student-label.js` = 2. 설치 버전 1.21.0.

## 표본 검증 (studentFullLabel 직접 호출)
| 케이스 | 입력 | 결과 | 비고 |
|---|---|---|---|
| 조효빈류 | 중등·grade="중2"·염경중학교 | `염경중` | 이전 `염경중중2` |
| 인천하늘고 | 고등·grade=2·인천하늘고등학교 | `인천하늘고2` | REGION_KEEP_EXACT 예외로 "인천" 유지 |
| 정상 | 고등·grade=3·양천고등학교 | `양천고3` | 무변화 |
| 진급 | 중등·grade=4·school_high 있음 | `염경고1` | 예측 학부 |
| 졸업 | 고등·grade=4·양천고 | `양천고(졸업+1)` | |

## 빌드
`npx vite build` 성공 — 36 modules, dist/assets/index-fCSrrMnw.js 527.30 kB.

## 커밋
- 해시: `68f415cae00543d5bc85eb17ed51d0b6de349ceb`
- master push 완료 (485a0c9..68f415c) → GitHub Actions 자동배포.
