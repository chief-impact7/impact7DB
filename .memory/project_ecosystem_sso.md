---
name: ecosystem-sso
description: 보류·차기 검토 — 에코시스템 전 앱 SSO(구글 1회 로그인). 분석 결론 포함, 다음에 사용자에게 다시 제안
metadata:
  type: project
---

# 에코시스템 SSO (구글 1회 로그인) — 분석 후 보류 (2026-05-28)

목표: 에코시스템 앱(DB/DSC/HR/exam/consultation/dashboard) 각각이 같은 패턴의 Google 로그인을 하는데, **한 번만 로그인하면 다른 앱도 모두 사용**하게 하기. 사용자가 "정리했다가 다음에 알려줘"로 보류.

## 핵심 분석 (재논의 시 여기서 출발)
- 현재: 모두 **같은 Firebase 프로젝트 + 같은 authDomain(impact7db.firebaseapp.com)**, `signInWithPopup`(Google), GIS 사일런트 토큰 갱신도 있음.
- **앱마다 로그인하는 진짜 이유**: Firebase Auth 세션은 **origin(도메인)별 IndexedDB 저장** → impact7db.web.app·impact7dsc.web.app 등 origin이 달라 **로그인 상태 미공유**. config 문제 아님, 브라우저 origin 격리. (서브도메인 전환해도 Auth 상태는 여전히 미공유. 단 Google 세션 자체는 브라우저 전역이라 2번째 앱 로그인은 비번 없이 빠름)

## 선택지
- **A. 한 origin 통합 (진짜 1회 로그인):** 전 앱을 한 도메인 경로로 서빙(예: app.impact7.kr/db,/dsc — Hosting rewrites/리버스 프록시). 같은 origin→세션 공유. 가장 깔끔하나 프레임워크 다른 6~7앱 라우팅·빌드·배포 통합이라 인프라 大작업.
- **B. 무마찰 자동 로그인 (체감 SSO, 권장 시작점):** Google One Tap(auto_select)/자동 사일런트 사인인을 각 앱에 추가 → 클릭 없이 자동 로그인(기존 Google 세션을 Firebase 자격증명으로 교환). 인프라 변경 0, 앱당 소량 코드. 한 앱 시범 적용부터 추천.
- **C. 중앙 토큰 전달(custom token SSO 포털):** 진짜 cross-domain SSO지만 구현·보안·유지보수 복잡 → 과함, 비권장.

## 권장
B로 시작(저비용, 사실상 1회 로그인 체감) → 진짜 단일 세션 필요 시 A 장기 과제. 곁들임: 중복된 로그인 코드를 **`@impact7/shared` 공통 auth 모듈로 추출**하면 B를 전 앱에 일관 적용 + 유지보수↑.

**How to apply:** SSO/로그인/인증 화제가 다시 나오거나 사용자가 이 건을 물으면 위 결론으로 제안. 진행 시 B(One Tap)부터 한 앱 시범.
