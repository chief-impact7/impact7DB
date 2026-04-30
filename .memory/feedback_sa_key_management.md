---
name: SA 키 단일화 정책
description: impact7 에코시스템의 firebase-adminsdk SA 키는 단일 키로 통일하고, 새 키 발급 시 모든 GH Secret을 동시에 갱신한다
type: feedback
---

impact7db Firebase 프로젝트의 `firebase-adminsdk-fbsvc@impact7db.iam.gserviceaccount.com` SA 키는 **단일 영구키**로 운영한다. 새 키를 발급하면 사용처 4곳(DB/DSC/HR GH Secret + 로컬 service-account.json)을 한 번에 모두 갱신하고, 옛 키는 GCP에서 즉시 폐기한다.

**Why:** 2026-04-24~25에 키 4개가 GCP에 누적된 상태에서 옛 키 한 개가 폐기되자 DB/DSC GH Actions 배포가 며칠간 깨졌던 사고가 있었다. HR만 새 키로 갱신되고 DB/DSC는 미갱신이라 `Invalid JWT Signature` 발생. GH Secret은 수동 갱신이라 누락되기 쉽다.

**How to apply:**
- SA 키 발급 → 즉시 다음 4곳 모두 갱신: 로컬 `impact7DB/service-account.json`, GH Secret `FIREBASE_SERVICE_ACCOUNT` × 3 (chief-impact7/impact7DB, impact7newDSC, impact7HR)
- 갱신 명령: `gh secret set FIREBASE_SERVICE_ACCOUNT -R chief-impact7/<repo> < /Users/jongsooyi/projects/impact7DB/service-account.json`
- 옛 키 폐기 전 반드시 3개 앱 모두 재배포 success 확인 (`gh run rerun <id>`)
- exam/qbank는 SA 키 미사용(배포 방식 다름). 제외.
- 평문 SA 백업 파일(`*.bak.*` 등) 만들지 말 것. `.gitignore`로 차단되어 있어도 디스크에 평문 private_key가 남는다. 키 교체는 GCP 발급 → 직접 덮어쓰기.
- 자동만료(60~90일) 키가 GCP에 보이면 무시해도 됨 — 자동 사라짐. 영구키만 관리 대상.
