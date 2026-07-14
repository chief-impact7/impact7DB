# 2단계 QA 보고서

- 검증일: 2026-07-14
- 최종 판정: 배포 가능

## 자동 검증

| 대상 | 명령 | 결과 |
|---|---|---|
| impact7DB | `npm run test:unit` | 통과, 36/36 |
| impact7DB | `npm run test:rules` | 통과, 147/147 |
| impact7DB | `npm run build` | 통과, 54 modules |
| DashBoard | `npm test -- --run` | 통과, 2 files, 41/41 |
| DashBoard | `npm run lint` | 통과 |
| DashBoard | `npm run build` | 통과, 610 modules |

기존 번들 크기 경고와 impact7DB의 기존 정적 스크립트 경고만 남아 있으며 이번 변경의 실패는 아니다.

## 회귀 검증

- 신규 상담·등원예정·재원을 각각 CONSULT·PLAN·ENROLL로 변환한다.
- 상담→등원예정→등록과 퇴원/종강→재등록 이력을 순서대로 재생한다.
- 같은 상태의 일반 UPDATE는 가짜 전환 이벤트를 만들지 않는다.
- 현재 문서에 최초 등록일이 없어도 과거 ENROLL 이력으로 퇴원생을 복원한다.
- 현재 재등록 시작일이 늦어도 과거 최초 ENROLL을 PLAN으로 오분류하지 않는다.
- 상담 관 미입력 레거시 학생을 현재 운영 관에 귀속하지 않는다.
- 유입 채널·상담 관은 레거시 1회 보완만 허용하고 이후 변경을 거부한다.

## 리뷰 게이트

- code-simplifier: `NO_CHANGE`
- code-reviewer: `APPROVE`
- architect: `CLEAR`

## 공유 Rules

네 저장소의 `firestore.rules` SHA-1:

`4f38ac9e37fe780e7108afc623dfb361b2d8fdff`

## 운영 제한

- 과거 데이터 백필은 수행하지 않는다.
- 기존 레거시 학생은 유입 채널·상담 관을 입력하기 전까지 `미입력`으로 집계된다.
- 인증된 운영 계정에서의 실제 입력·화면 확인은 배포 후 smoke test 대상으로 남긴다.
