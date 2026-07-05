# Executive Summary

## 축별 판정

| 축 | 판정 | 근거 |
| --- | --- | --- |
| 정합성 | 양호, 일부 구조 리스크 | `@impact7/shared` root/functions/functions-shared 모두 v1.38.0 일치. Firestore rules가 students enrollment/status, HR 공개 토큰, exam 권한 상승을 테스트로 방어. 단 `app.js` 로컬 상태와 `store.js` 계약은 직접 mutation이 남아 drift 위험이 있다. |
| 신뢰성 | 조건부 양호 | CI식 emulator 검증은 통과. `functions` 단독 `npm test`는 emulator 없이 23개 integration timeout으로 실패해 실행 계약이 명확하지 않다. |
| 안정성 | 개선 필요 | `firestore.rules`, `storage.rules`, message_queue 차단은 강하다. 반면 runtime dependency audit 실패와 App Check 미적용 callable이 남아 있다. |
| 신속성 | 취약 | Vite build는 성공하지만 메인 JS chunk가 632.49KB이고 `app.js`가 312KB다. 기능 추가·회귀 검증이 계속 느려지는 구조다. |
| 운영성 | 보통 | GitHub Actions deploy-functions는 validate 후 deploy로 개선됨. 다만 deploy 후 region 내 모든 Cloud Run 서비스에 `allUsers` invoker를 반복 부여하는 방식은 미래 서비스 추가 시 위험하다. |

## 좋은 상태

- `firebase.json`은 Functions codebase를 `leave-request`와 `shared`로 분리하고, 각 codebase별 predeploy 검증을 둔다.
- `.github/workflows/deploy-functions.yml`은 push/PR 검증 게이트를 두고, shared parity, functions lint, functions-shared unit, functions emulator integration, Firestore rules를 순차 실행한다.
- `storage.rules`는 HR 파일 경로를 클라이언트 직접 접근 `false`로 잠그고, exam/DSC 경로만 제한적으로 허용한다.
- root `npm test`, `npm run test:storage`, `functions-shared npm test`, `functions` emulator 통합 테스트가 모두 통과했다.

## 지금 막아야 할 리스크

- runtime dependency audit 실패: root critical, functions high 다수, functions-shared high 포함.
- callable App Check rollout 미완료: 주석은 카나리/롤백을 언급하지만 실제 `enforceAppCheck: false`가 광범위하다.
- Cloud Run public invoker 복구가 서비스명 allowlist 없이 전체 region 대상으로 돈다.
- `functions`의 test script가 CI 실행 방식과 달라 로컬/에이전트 검증에서 오판을 만든다.
- `app.js` 직접 상태 mutation과 대형 번들로 수정 단위가 지나치게 넓다.
