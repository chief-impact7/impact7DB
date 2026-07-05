# 검증 증거

## 실행 결과

| 검증 | 결과 |
|---|---|
| `npm run build` | 통과 |
| JS/MJS 구문 검사 | 147개 통과 |
| `npm --prefix functions run lint` | 통과 |
| 루트 순수 테스트 | 통과 |
| Firestore rules 테스트 | 격리된 emulator 환경에서 54/54 통과 |
| Functions 통합 테스트 | 파일별 실행 통과, 병렬 실행 시 데이터 삭제 경쟁 발생 |
| functions-shared 테스트 | 282/285 통과 |
| 제외된 출결 테스트 | 5/7 통과 |
| `git diff --check` | 통과 |
| 작업 트리 | 리뷰 종료 시 clean |

## 현재 실패하는 테스트

### functions-shared

1. `chatSyncHandler.test.js`
   - 고정된 2026-06-12 fixture와 현재 날짜 기반 기본 cursor가 충돌한다.
2. `student-label-sync.test.js`
   - 테스트는 폐기된 `school` 미러 write를 기대한다.
   - 구현은 `school_*` SSoT 계약에 따라 mirror write를 중단했다.
3. `attendanceState.test.js`
   - 테스트는 구 라벨 `복귀`를 기대한다.
   - 현재 shared 계약은 `귀원`이다.
   - 이 파일은 기본 Vitest suite에서 제외되어 실패가 숨겨진다.

### Functions emulator integration

- 세 integration 파일이 같은 `impact7db-test` 프로젝트와 같은 컬렉션을 공유한다.
- 병렬 `beforeEach` 삭제가 다른 파일의 fixture를 제거한다.
- 대표 실패:
  - `NOT_FOUND: no entity to update`
  - history log 중복
  - hook timeout

## CI/배포 확인

- `master` branch protection: 비활성
- required status checks: 없음
- Functions workflow: test/lint/build 단계 없이 배포
- Hosting dispatch:
  - 상위 workflow 성공과 downstream 실제 성공이 연결되지 않음
  - 같은 시간대 downstream 취소 사례 확인

## 의존성 감사

`npm audit --omit=dev` 기준:

| 패키지 | Critical | High | Moderate | Low |
|---|---:|---:|---:|---:|
| root | 1 | 1 | 1 | 0 |
| functions | 0 | 4 | 12 | 1 |
| functions-shared | 0 | 2 | 9 | 0 |

감사 결과는 취약 패키지 존재 증거이며, 개별 취약점의 실제 도달 가능성은 별도 분석이 필요하다.

## 테스트 범위 공백

- Firestore rules `match` 블록에 비해 rules 테스트 파일이 매우 적다.
- HR 토큰, 직원 문서, 계약, `exam_users`, 메시지 큐, 결제, 키오스크 규칙이 자동 검증되지 않는다.
- Storage rules 테스트가 없다.
- post-deploy smoke test와 rollback workflow가 없다.
