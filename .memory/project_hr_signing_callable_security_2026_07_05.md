---
name: project-hr-signing-callable-security
description: HR 공개 서명(강사계약·급여약정·근로계약)은 서버 callable 전용 — 익명 계약 write 규칙 재도입 금지
metadata:
  type: project
---

2026-07-05, HR 공개 서명 3종의 서명 write를 서버 callable로 완전 이관하고 firestore.rules의 익명 계약 서명 update를 제거했다.

**보안 불변식(반드시 유지):**
- 공개(비로그인) 서명 write는 callable 전용이다: `submitContractSignature`(강사계약), `submitSalaryAgreementSignature`(급여약정), `submitEmployeeContractSignature`(근로계약). 모두 functions-shared, `enforceAppCheck:false`, 토큰 게이트.
- firestore.rules의 `staff/{id}/contracts`·legacy `employees/{id}/contracts`에 **익명 `allow update`(signatures·salaryAgreement)를 다시 추가하지 말 것.** rules는 최상위 키(hasOnly)만 검증하고 signatures 중첩 내용을 못 봐서, 익명 write를 열면 signatures.director 덮어쓰기·`data:image/svg+xml` 저장형 XSS가 재개방된다. 관리자·director 서명은 인증된 `allow write: if isDirector()`가 커버.

**callable 계약:**
- 경로 ID(staffId/employeeId·contractId)는 토큰 doc에서만 도출(호출자 입력 무시, IDOR 차단). contractId는 보내면 일치 검증만.
- 서명은 raster PNG/JPEG data-URL만(`assertSignatureDataUrl`, ≤900KB — 계약 doc inline 저장이라 Firestore 1MiB 한도 아래). SVG 거부.
- signedPdfUrl/salaryPdfUrl은 Firebase Storage 다운로드 URL만(`assertStorageUrlOrEmpty`, hrStorage.js) — 피싱/javascript: URL 차단.
- 서명+status+토큰 소진을 단일 트랜잭션으로 원자 갱신(이중제출·TOCTOU 차단).

**토큰 게이트 write 이관의 롤아웃 순서(엄수):** callable 배포(가산적·안전) → 클라 배포 → rules 조임. rules를 먼저 조이면 라이브 구 클라의 직접 write가 깨진다. 이번에도 이 순서로 3커밋(DB 백엔드 6d62f23 → HR 클라 4cb7a5c → DB rules e93f290 + 4-repo 동기화)으로 진행. [[feedback_role_rename_atomic_migration]]

**참고:** 읽기 경로(getHrPublicToken)는 별건의 인시던트(d121dd8, 서명 write ref용 ID 반환)로 먼저 복구됨. 설계 상세는 `docs/superpowers/specs/2026-07-05-hr-signature-server-callable-design.md`.
