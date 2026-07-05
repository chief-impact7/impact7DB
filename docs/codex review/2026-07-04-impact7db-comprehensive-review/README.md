# impact7DB 종합 적대 리뷰

검토일: 2026-07-04

## 결론

현재 `impact7DB`는 6월 감사 이후 보안 규칙, Storage 잠금, Functions 배포 게이트, `@impact7/shared` 동기화가 상당히 보강되어 핵심 운영 경계는 이전보다 안정적이다. 실제 검증에서도 root build, root unit/rules, Storage rules, `functions-shared`, `functions` emulator 통합 테스트는 통과했다.

다만 merge-ready 관점에서는 `REQUEST CHANGES`다. 런타임 의존성 audit가 root/functions/functions-shared 모두 실패하고, App Check가 민감 callable 전반에서 아직 꺼져 있으며, 배포 후 모든 Cloud Run 서비스에 public invoker를 재부여하는 워크플로가 미래 서비스까지 공개 경계로 끌고 갈 수 있다. `app.js` 대형 단일 파일과 직접 상태 mutation도 신속성·변경 안정성의 주요 병목이다.

## 문서

- [01-executive-summary.md](01-executive-summary.md): 축별 판정
- [02-findings.md](02-findings.md): 적대적 발견사항과 파일 근거
- [03-validation-evidence.md](03-validation-evidence.md): 실행한 검증 명령과 결과
- [04-remediation-plan.md](04-remediation-plan.md): 우선순위별 개선 순서
- [05-handoff-prompt.md](05-handoff-prompt.md): 다음 에이전트 전달용 프롬프트

## 검토 범위

- 프론트엔드: `app.js`, `store.js`, `index.html`, `style.css`, Vite build 산출
- 보안 규칙: `firestore.rules`, `storage.rules`, root rules tests
- 백엔드: `functions/`, `functions-shared/`, callable/auth/queue/schedule 경계
- 운영: `firebase.json`, `.github/workflows/*.yml`, deploy script, shared lock sync
- 검증: build, tests, lint, emulator tests, audit, whitespace check

## 바로 볼 핵심

1. 보안/운영: `npm audit --omit=dev`가 세 패키지에서 실패한다.
2. 신뢰성: `functions/package.json`의 단독 `npm test`는 emulator 없이 integration hook timeout으로 실패한다.
3. 안정성: callable 대부분이 `enforceAppCheck: false`이며 abuse 방어가 auth/rate-limit 일부에 의존한다.
4. 신속성: `app.js` 312KB, build chunk 632KB로 계속 커지고 있어 수정·검증 단위가 크다.
5. 정합성: Firestore/Storage rules와 shared parity는 현재 강한 편이고, 관련 regression tests가 통과했다.
