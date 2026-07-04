# HR 공개 서명 서버 callable 이관 설계

날짜: 2026-07-05
대상 repo: impact7DB(functions-shared·firestore.rules SSoT), impact7HR(공개 서명 페이지)

## 배경 / 문제

HR 공개 서명 페이지(강사계약·급여약정)는 PDF 업로드는 토큰 게이트 callable
(`uploadSignedContractFile`)로 서버화돼 있으나, **서명 자체는 여전히 비인증
클라이언트가 `updateDoc(staff/{id}/contracts/{id})`로 직접 write**한다. 이 write를
firestore.rules가 `diff().affectedKeys().hasOnly([...])`로 게이트하지만, rules는
**최상위 키만** 검증하고 **중첩 내용은 검증하지 못한다.** 따라서 유효 토큰 보유자가:

- `signatures.director`(원장 서명 이미지)를 임의 값(SVG data-URL 포함)으로 덮어써
  관리자 세션에서 **stored XSS**를 유발하거나 법적 서명을 파괴할 수 있고,
- `signatures.staff.signatureUrl` / `salaryAgreement.signatureUrl`에 SVG를 주입할 수 있다.

근로계약(employee) 흐름은 이미 `submitEmployeeContractSignature` callable로 이 위험을
차단해 뒀다(raster PNG/JPEG data-URL만 허용, 자기 서명만 write, 토큰에서 ID 파생).
이 패턴을 강사계약·급여약정에 확장하고, 이관 완료 후 rules의 익명 서명 update를 제거한다.

## 설계

### 1) 백엔드 — functions-shared (impact7DB 소유)

`submitEmployeeContractSignature`를 본떠 callable 2개 추가. 경로 ID는 토큰 doc에서만
도출(호출자 입력 무시), 트랜잭션으로 서명+토큰 소진을 원자 갱신한다.

- `submitContractSignature` (토큰: `contractSigning`)
  - 검증: signatureUrl은 `data:image/(png|jpeg);base64,...`만, ≤2MB. (공통 헬퍼)
  - `signatures.staff`만 write + `status='signed'` + `signingTokenId` + (선택)`signedPdfUrl`.
  - employee와 달리 `staff.status='active'`는 **건드리지 않는다**(강사는 이미 재직).
- `submitSalaryAgreementSignature` (토큰: `salaryAgreement`)
  - 동일 서명 검증.
  - `salaryAgreement.status='signed'` + `salaryAgreement.signatureUrl` +
    `salaryAgreement.signedAt` + `agreementTokenId` + (선택)`salaryPdfUrl`. 계약 `status`는 불변.
  - 계약 status는 `['signed','salary_agreement_sent']`여야 함(rules와 동일 전제).
- 공통 서명 검증을 `hrStorage.js`에 `assertSignatureDataUrl`로 추출, 기존 employee
  핸들러도 이를 쓰도록 리팩터(중복 3곳 제거).

응답: `{ ok: true, staffId, contractId }` / `{ ok: true, staffId, contractId }`.

### 2) HR 클라 — impact7HR

두 공개 페이지(`public/contract/[token]`, `public/salary/[token]`)에서:

- **읽기 경로(장애 복구)**: `readTokenRefIds`(비인증 getDoc) 제거 → 앞서 배포한
  `getHrPublicToken` 응답의 `staffId`/`employeeId`/`contractId` 사용.
- **쓰기 경로(보안)**: `updateDoc(contractRef, ...)` + `completeXxxToken` 제거 →
  PDF 업로드 후 새 callable 호출. 실패 시 코드 매핑은 employee 페이지와 동일.
- `publicToken.ts`의 `readTokenRefIds` 및 응답 인터페이스에 신규 필드 반영.

### 3) Rules — impact7DB SSoT → 4개 repo 동기화

`/staff/{staffId}/contracts` 블록(현행 961–979)과 legacy `/employees/.../contracts`
블록(1108–1124)에서 **익명 서명 update 2종**(`signatures` ready→signed,
`salaryAgreement`) 제거. `signedPdfUrl`만 쓰는 PDF-repair update(URL 문자열, XSS 벡터
아님)는 **유지**. 토큰 자체의 익명 pending→signed 규칙은 이번 범위 밖(콘텐츠 주입
아님)이라 유지하되, 클라가 더는 호출하지 않는 dead 규칙으로 남는다.

## 롤아웃 순서 (엄수 — 어기면 서명이 다시 깨짐)

1. **callable 배포**(가산적·안전): `firebase deploy --only functions:shared:submitContractSignature,functions:shared:submitSalaryAgreementSignature`
2. **HR 클라 배포**: 읽기+쓰기 경로를 callable로 교체 후 push(Actions 자동 배포). 라이브 검증.
3. **rules 조임 배포**: 익명 서명 update 제거 후 `firebase deploy --only firestore:rules` + 4 repo 동기화.

## 롤백

- callable 문제: 이전 revision으로 재배포(가산적이라 클라 하위호환).
- rules 조임 후 서명 실패: rules만 이전 사본으로 즉시 재배포하면 익명 write 경로 복구.

## 테스트

- functions-shared: 신규 callable 각각 성공/토큰무효/만료/이중제출/SVG거부/ID불일치 케이스.
- HR: svelte-check + 공개 페이지 수동 서명 1회(강사·급여) 링크 검증.
