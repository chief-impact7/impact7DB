# H-01 설계 — Storage HR 경로 권한 (역할·소유권 강제)

- 발견: H-01 (storage.rules가 impact7 도메인 직원이면 모든 HR 계약·서명·경비 read/write 허용 — Firestore의 director/assignedTo보다 훨씬 넓음, 크기·MIME 무제한)
- 상태: **설계** (구현은 결정 후, 배포는 G12)

## 핵심 제약 (왜 단순 규칙 조임이 안 되나)

1. **Storage rules는 Firestore를 읽을 수 없다.** `firestore.get()` 같은 교차 서비스 조회가 없다. 따라서 `HR_users/{uid}.role`(director/staff) 기반 접근을 storage rules에서 직접 표현 불가. 표현 가능한 신원 정보는 `request.auth`(uid, token claims)뿐.
2. **`contracts/` 경로엔 비인증 writer가 있다.** 공개 서명 페이지(로그인 없는 신규입사자·계약자)가 `contracts/{ownerId}/{contractId}/{type}_signed.pdf`에 직접 업로드한다(`public/contract/[token]:138`, `public/salary/[token]:101`). 비인증이라 custom claim으로도 게이트 불가.

## 실제 Storage 사용 맵 (조사 결과)

| 경로 | writer | 현황 |
|------|--------|------|
| `exam-papers/`, `scans/` | impact7exam(인증) | HR 무관 — `isAuthorized()` 유지 |
| `staff/{staffId}/documents/` | 인증 HR 직원(`documents.ts:85`) | 활성. 역할 게이트 대상 |
| `contracts/{ownerId}/{contractId}/` | 인증 관리자(`contracts/[id]:84`) + **비인증 서명자**(`public/...:138,101`) | 활성. 비인증 write가 핵심 난점. 현재 비인증 업로드는 storage `isAuthorized()`에 막혀 try/catch로 degrade(서명만 저장, PDF 누락 = HR-13) — **이미 부분 파손** |
| `signatures/` | **없음** | 서명 이미지는 Firestore data URL로 저장(`signatures.staff.signatureUrl=staffSignature`). storage 경로 미사용 추정 |
| `expenses/` | **없음**(HR src 기준) | 미사용/미구현 추정 |

## 옵션 비교

### A. Custom claims (역할을 토큰 클레임으로)
- `HR_users/{uid}.role` 변경 시 Cloud Function이 `setCustomUserClaims(uid, { hrRole })` 동기화 → storage rules가 `request.auth.token.hrRole`로 게이트.
- 장점: 인증 직원의 역할 게이트를 storage rules에서 직접 표현. HR 업로드 코드 변경 최소.
- 단점: 클레임 전파 지연(토큰 갱신까지 ~1h), 1KB 제한. **비인증 서명자에는 무력**(계정 없음).

### B. Callable 서명 write (서버 매개)
- 공개 서명자가 PDF를 callable에 전송 → callable이 토큰 검증 후 Admin SDK로 storage write + URL 반환. storage `contracts/` 직접 client write 전면 차단(Admin 우회).
- 장점: 비인증 write 구멍을 안전하게 폐쇄. **현재 degrade(HR-13)도 동시 해결**. 토큰 검증과 결합.
- 단점: HR 공개 서명 플로우의 업로드 부분 재작성. PDF 생성(클라 jsPDF)을 서버로 옮기거나 PDF blob을 callable로 전송.

### C. 미사용 경로 정리 + MIME/크기 제한 (즉시 안전)
- `signatures/`·`expenses/` writer 부재 확인 후 director 전용 또는 제거. 전 경로 size/MIME allowlist 추가.
- 장점: 플로우 무파손, 즉시 적용 가능. 단점: 인증 직원 간 역할 게이트는 미해결(부분 개선).

## 권장: 하이브리드 (C 즉시 → A+B 본구현)

**1단계 — 즉시 안전 하드닝(C, 플로우 무파손, 지금 가능):**
- 전 HR 경로에 size 상한(예: 20MB) + MIME allowlist(`application/pdf`, `image/*`) 추가.
- `signatures/`·`expenses/`: 실사용 0 확인 후 `allow read,write: if false`(서버 전용) 또는 경로 제거. (사용처 발견 시 director 한정.)
- `read`/`write`/`delete` 동사 분리(현재 `read,write` 합쳐짐).

**2단계 — 역할 게이트(A):**
- `functions-shared`(또는 HR functions)에 `onHrUserRoleChange` 트리거: `HR_users/{uid}` write → `setCustomUserClaims(uid, { hrRole: role })`. 부트스트랩용 백필 스크립트 1회.
- storage rules: `staff/{staffId}/documents/**`는 `hrRole in ['owner','principal','director']`(또는 `canManageEmployees`) write, 본인(`request.auth.uid == staffId`) read 등 정책 확정.

**3단계 — 공개 서명 write 폐쇄(B):**
- `functions-shared`에 `submitSignedContract` callable: { tokenId, tokenType, pdfBase64, signature } 수신 → 토큰 검증(G02 검증 로직 재사용) → Admin SDK로 `contracts/...` write + 계약 doc update + URL. 성공 후 storage `contracts/` client write를 `if false`로.
- HR 공개 서명 페이지(`public/contract`·`salary`·`employee-contract`)를 이 callable 호출로 전환(G10 연장). HR-13 degrade도 해소.

## 구현 순서 / 배포(G12)

1. 1단계(MIME/크기 + 미사용 경로) — storage.rules 단독, 저위험. 먼저 배포 가능.
2. 2단계 claim-sync 함수 배포 → 백필 → storage rules 역할 게이트 반영.
3. 3단계 callable 배포 → HR 서명 페이지 전환 배포 → storage `contracts/` client write 차단.
- storage.rules는 impact7DB가 SSoT — 변경 시 5앱 영향. 각 단계 후 exam(exam-papers/scans)·HR 업로드/다운로드 smoke 필수.

## 테스트 계획
- `@firebase/rules-unit-testing`의 storage emulator(`initializeTestEnvironment({ storage })`)로 `tests/storage.rules.test.js`:
  - 비인증 read/write/delete 거부(전 경로)
  - 역할 없는 직원(hrRole 미보유)의 staff documents/contracts write 거부
  - director(claim 보유)만 허용
  - MIME 위반·용량 초과 거부
  - exam-papers/scans는 도메인 직원 허용(회귀)
- claim-sync 함수: HR_users role 변경 → setCustomUserClaims 호출 단위 테스트(mock auth).
- callable submitSignedContract: 토큰 검증·Admin write·URL 반환 + 만료/사용됨 거부.

## 결정 필요 사항 (사용자 확인)
1. 2단계 역할 게이트를 **custom claims(A)**로 갈지, 아니면 모든 HR 파일 접근을 **callable 서명URL(B 확장)**로 통일할지.
2. `staff documents` read 권한: director 전용인지, 본인(staffId==uid) 허용인지 — HR의 staffId가 auth uid와 일치하는지 확인 필요.
3. `signatures/`·`expenses/` 경로를 제거할지(미사용 확정 시) 보존할지.

## 즉시 적용 가능한 최소 변경(승인 시)
1단계만이라도 먼저: 전 HR 경로 size/MIME 제한 + `signatures/`·`expenses/` 서버전용화 + storage emulator 테스트 신설. 이는 플로우를 깨지 않고 공격면(임의 대용량/임의 타입 업로드, 미사용 경로 노출)을 줄인다. 본 역할 게이트(A/B)는 결정 후 G12 묶음.
