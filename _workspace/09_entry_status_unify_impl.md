# 구현 보고 — 진입 상태 '등원예정' 단일화 + 버튼 정리

스펙: `_workspace/08_entry_status_unify_spec.md`. **DB 코드만 변경. 공유모듈(@impact7/shared)·firestore.rules·마이그레이션 무변경.** 커밋·푸시 안 함.

## 변경 파일
| 파일 | 변경 |
|------|------|
| `app.js` | #1+#2 헤더 버튼 상태별 표시/라벨, #3 신규 폼 기본값·저장 폴백 |
| `index.html` | 재등록 버튼 라벨 span에 id 부여 |
| `functions/src/buildUpdate.js` | **#4 핵심** — 복귀/재등원 finalize status '재원'→'등원예정' |
| `functions/test/buildUpdate.test.js` | RETURN 케이스 기대값 갱신 + start_date 검증 추가 |
| `functions/test/finalize.integration.test.js` | 재등원 통합 케이스 기대값 갱신 |

## #1 퇴원 헤더 '재등록' 버튼 제거 + #2 라벨 분기 (app.js selectStudent)
- 기존: `isActiveStudentStatus`로 비활성(상담/퇴원/종강)이면 무조건 '재등록' 노출.
- 변경: 룩업 `{ '상담':'신규등록', '종강':'재등록' }`로 매핑.
  - **상담 → "신규등록"** (과거 재원 아님).
  - **종강 → "재등록"** (과거 재원생).
  - **퇴원 → 숨김** (재등원은 퇴원요청서 카드의 재등원 버튼 `openReEnrollModal`로만).
  - 재원 계열·빈값 → 숨김.
- title/aria-label도 라벨에 맞춰 동적 갱신. index.html은 텍스트 span에 `id="reenroll-btn-label"` 부여(견고한 selector).
- `isActiveStudentStatus`는 app.js:2803에서 계속 사용 → 미사용 아님.

## #3 신규등록 폼 status 기본값 '등원예정'
- `populateStatusOptions`(app.js): `opts[opts.length-1]`(마지막=재원) → `opts[0]`(첫=등원예정).
  - 공유모듈 `selectableStatuses` 반환 순서가 `INITIAL_STATUSES=['등원예정','재원']`이라 신규/비원생재등록 첫 항목이 '등원예정'. **편집 모드는 current 보유 시 그대로 유지**(데이터 정정용 재원 선택 보존).
- 저장 폴백(app.js submitNewStudent): 수업 보유 시 `f.status?.value || '재원'` → `|| '등원예정'`.
- `INITIAL_STATUSES`/`selectableStatuses`는 건드리지 않음 → 재원 수동 선택 가능.

## #4 (a) 재등원/복귀 승인 적용 — 실제 지점과 변경 내용
**실제 적용 지점은 클라이언트가 아니라 Cloud Function이다.**

복귀/재등원 모달(`submitReturnFromLeave`, app.js:5293)은 `leave_requests` 문서만 생성한다. 양 부서 승인(`teacherApprove`/`approveLeaveRequest`)도 leave_requests의 워크플로 status만 바꾼다. 주석 명시(app.js:5420,5468): **"최종 승인 시 학생 상태 전이는 Cloud Function(onLeaveRequestApproved)이 처리"**.

전이 경로:
`onLeaveRequestApproved`(functions/index.js:72) → `finalize`(functions/src/finalize.js) → `buildUpdate`(functions/src/buildUpdate.js).

`buildUpdate.js`의 RETURN_TYPES(복귀요청/재등원요청) 분기에서 학생 status를 직접 세팅한다. 여기를 변경:
- `const studentUpdate = { status: '재원' };` → `{ status: '등원예정' };`

이로써 finalize가 학생 문서를 status='등원예정'으로 set하고, 복귀일에 promoteEnrollPending이 자동 '재원' 전환한다.

> 참고: 스펙이 지목한 "폼 저장 isReturnToActive 분기(app.js~2278)"는 **편집 모드에서 운영자가 status를 직접 '재원'으로 골라 저장**할 때만 트리거되는 데이터-정정 경로(휴원/퇴원→재원 cleanup). 스펙 제약("편집 모드 재원 선택은 데이터 정정용으로 유지")에 따라 **그대로 유지**. 승인 적용의 실제 status 세팅은 위 finalize/buildUpdate가 담당하므로 거기서 수정함.

## #4 (b) enrollment.start_date를 복귀일에 어떻게 물렸는가
**이미 물려 있었다 — 추가 작업 불필요, 검증만 했다.**

`buildUpdate.js`는 RETURN 시 `replaceRegularEnrollment(student, target_class_code, r.return_date || today, ...)`를 호출한다(functions/src/enrollments.js).
- `replaceRegularEnrollment`는 기존 정규 enrollment를 교체하며 새 정규 enrollment의 `start_date: returnDate`(=복귀일)로 세팅한다(enrollments.js:22).
- 즉 target 반 enrollment의 start_date가 이미 복귀일에 연결돼 있었다. status만 '재원' 직접 세팅하던 것을 '등원예정'으로 바꾸면, promote 메커니즘이 그 start_date를 보고 작동한다.

promote 조건(@impact7/shared/promote-enroll.js):
```
s.status === '등원예정' && (s.enrollments||[]).some(e => e.start_date && e.start_date <= today)
```
- 복귀일 ≤ 오늘 → 다음 promote 사이클에서 즉시 '재원' (같은날 복귀 정상).
- 복귀일 > 오늘 → 그날까지 등원예정 유지 → 복귀일 도래 시 재원.

**정합성**: 등원예정은 enrollment≥1 필요(reconcileEnrollments). `replaceRegularEnrollment`가 정규 enrollment를 항상 추가(target_class_code 있을 때) 또는 기존 보존(없을 때)하므로 충족. finalize는 pause_*/withdrawal_date/scheduled_leave_status를 deleteField로 정리 → 잔존 필드 없음.

**promote 실행 주체 주의**: Cloud Functions에는 promote 스케줄러가 없다(`functions/`에서 promoteEnrollPending 미사용 확인). promote는 **클라이언트 DB 앱 로드 시 `loadStudentList`(app.js:505)에서만** 돈다. 따라서 "복귀일=오늘 즉시 재원"은 운영자가 DB 앱을 여는(또는 이미 열려 있다가 다음 로드하는) 시점에 반영된다 — 기존 등원예정 신규생과 동일한 동작이며 회귀 아님.

## #4 (c) DSC 조사 결과 — DSC 변경 불필요
**impact7newDSC/leave-request.js**도 DB와 동일 구조다:
- `submitReturnFromLeave`(line 922~): leave_requests 문서만 생성.
- `teacherApproveLeaveRequest`/`approveLeaveRequest`(line 762~801): leave_requests 워크플로 status(requested/approved)만 변경. 주석 명시(line 750,801): "최종 승인된 경우 학생 상태 전이는 Cloud Function(onLeaveRequestApproved)이 처리".
- DSC에서 학생 status를 직접 '재원'으로 set하는 코드 없음(grep 확인: `{ status: ... }`는 전부 leave_requests의 워크플로 상태).

**결론**: DB·DSC가 동일한 Cloud Function `onLeaveRequestApproved`→finalize→buildUpdate를 공유하므로, `buildUpdate.js`를 '등원예정'으로 바꾼 것만으로 **DSC 경로의 복귀/재등원도 자동으로 등원예정 진입으로 통일**된다. **DSC 코드 추가 변경 없음.**

> 단, DSC의 신규등록 폼(있다면)에 status 기본값 '재원' 폴백이 있는지는 이번 범위(#3=DB 폼) 밖이라 미조사. DSC가 학생 신규등록 폼을 갖는지는 후속 확인 권장(이번 스펙은 DB 폼만 명시).

## (d) 빌드/테스트 결과
- `npx vite build` → **성공** (`built in 5.60s`, 에러 없음). 청크 500KB 경고는 기존부터 존재, 이번 변경 무관.
- `functions/` `npx vitest run test/buildUpdate.test.js` → **12 passed** (등원예정 + start_date=복귀일 검증 포함).
- `finalize.integration.test.js`는 Firestore emulator 필요로 미실행. 단위 로직(buildUpdate)은 검증됨.

## 후속(이번 범위 밖, 알림용)
- buildUpdate.js·테스트는 **Cloud Function 미배포 상태**. 실 반영하려면 `firebase deploy --only functions:leave-request --project impact7db` 필요(별도 승인 후).
- DSC 신규등록 폼 status 기본값 정합성 점검(있을 경우).
