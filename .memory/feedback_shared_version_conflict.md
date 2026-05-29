---
name: feedback-shared-version-conflict
description: 크로스앱 실행 전 @impact7/shared 현재 version·태그 확인 — 계획이 가정한 버전이 선점됐을 수 있음
metadata:
  type: feedback
---

크로스앱 계획이 `@impact7/shared`의 특정 버전(예: v1.11.0)을 새로 태그한다고 적혀 있어도, **실행 시점엔 다른 작업/세션이 그 번호를 이미 점유했을 수 있다.** 계획은 작성 시점 기준이라 그 사이 shared가 올라갈 수 있음.

**How to apply:** 크로스앱 shared 작업 실행 전 반드시 확인:
```
cd ~/projects/impact7-shared && grep '"version"' package.json && git tag | grep v1.1
```
점유됐으면 **다음 번호로 조정**하고, 계획의 모든 해당 버전 참조(shared package.json, DB/DSC 핀 `#vX`, 커밋 메시지)를 일괄 수정한다.

**Why:** 2026-05-29 — newDSC 세션의 `deriveTenure 첫출석` 계획이 v1.11.0을 가정했으나, 같은 날 impact7DB 세션의 `moveClass` 작업이 v1.11.0을 이미 태그·push해 선점. 그대로 진행했으면 태그 충돌 또는 moveClass 파괴. → **v1.12.0으로 한 칸 밀어** 해결(파일이 달라 코드 충돌은 없었음, class-move.js vs history-classifier.js).

**부수 교훈:** `npm install`이 github 태그를 캐시 등으로 못 받아 `npm link`(심볼릭 링크)로 떨어지면 **package-lock.json이 갱신 안 돼 CI `npm ci` 배포가 옛 버전으로 깨진다.** 명시 설치 `npm install @impact7/shared@github:chief-impact7/impact7-shared#vX.Y.Z` 후 `readlink node_modules/@impact7/shared`(링크면 문제)·lock `resolved` 커밋 해시를 확인할 것. [[class-move-unification]]
