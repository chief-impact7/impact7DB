# 이슈2 — 퇴원 학생 수업추가 시 status 무단 재원 전환 가드

## 1. enrollment→students 저장 경로 목록

| # | 함수/위치 | enrollment write | status 처리 | 퇴원생 도달? |
|---|-----------|------------------|-------------|-------------|
| A | `submitNewStudent` 편집모드 RETURN (app.js ~2399-2459) | reconcile→setDoc merge | `isReturnToActive` 감지, RETURN+STATUS_CHANGE 로그 | 정상(이미 로그됨) |
| B | `submitNewStudent` `existingStudent` 재등록 분기 (~2464-2522) | enrollments append + status=`_newStatusForCreate`(재원계열) | **무로그 UPDATE만** | **YES — 심예율 메커니즘** |
| C | `submitNewStudent` 완전신규 분기 (~2500+) | 신규 생성 | ENROLL 로그 | N/A(신규) |
| D | `window.saveEnrollment` Firestore 분기 (~3090) | enrollments merge, **status 불변** | 없음 | UI 호출처 없음(latent), exported |
| E | 문법특강 일괄 `saveGrammarSpecial` (~6071-6084) | batch.update enrollments, status 불변 | 없음 | YES(CSV docId 매칭, status 무관) |
| F | 자동전환 배치 handleScheduled* (633·685·752) | enrollment 추가는 재원계열만(`ENROLLABLE_STATUSES.has` 가드) | — | 차단됨 |
| G | 재등원 정식경로 `openReEnrollModal`→leave_requests→CF finalize | 서버에서 status+enrollment+RETURN | 서버 로그 OK | 정답 경로 |

## 2. 무단 전환 메커니즘 (심예율)

상세뷰는 퇴원생에게 "정규 등록"(=재등원 G경로) 버튼만 노출하나, **신규등록 폼으로 퇴원생을 재입력**하면 경로 B 진입.
- 정합성 reconcile(2355-2363)은 신규모드에서 `_newStatusForCreate`(재원/등원예정)로 돌므로 통과.
- `mergeData.status`를 재원계열로 올리고 enrollment append → firestore.rules `enrollmentStatusConsistent`(status가 재원계열이라) 통과.
- 그러나 로그는 `change_type:'UPDATE'`, after `"첫데이터 재입력…"` 뿐 → **RETURN/STATUS_CHANGE 부재**.
- `classifyHistory`는 구버전 휴리스틱(line71: before퇴원+"재입력"+"수업"+"추가")으로만 잡아 취약. deriveTenure가 재등원 시작을 못 잡아 end=퇴원일(03-12) 고정 → 이슈3 03-12~03-12.
- 경로 D는 status를 안 건드려 rules가 거부(merge 후 status=퇴원+enrollment>0) — 무로그 전환은 아니나 비정상.
- 경로 E도 동일하게 rules 거부(배치 전체 실패) — 가드 없이 깨짐.

## 3. 택일: B(재등원 명시) + A(차단) 혼합

- **경로 B(재등록 폼)**: 사용자의 의도적 "비원생 되살리기" UX → **B안(RETURN 로그)** 채택. 차단하면 정당한 재등록을 막음.
- **경로 D·E(수업추가/일괄특강)**: 재등록 UX 아님, status 손대지 않아 rules 거부·오염 위험 → **A안(차단+안내)** 채택. 정식 재등원 후 추가 유도.

## 4. 가드 구현 (app.js, 빌드 통과)

- import에 `NON_ENROLLABLE_STATUSES` 추가.
- **B경로(~2489-2522)**: `isReEnroll = NON_ENROLLABLE_STATUSES.has(prev) && ENROLLABLE_STATUSES.has(mergeData.status) && 새수업>0` →
  `change_type:'RETURN'`, before `상태:퇴원` / after `상태:재원, 반:HA103 (재등원 …)` (classifyHistory 인식 포맷), + `STATUS_CHANGE` 로그, + status_changed_* 메타.
- **D경로 saveEnrollment(~3093)**: 비원생이면 alert("정규 등록(재등원) 버튼으로 처리") 후 return.
- **E경로 saveGrammarSpecial(~6079)**: 비원생 existing은 `skippedWithdrawn`에 모아 `continue`, 저장 후 제외 명단 alert.

## 5. 검증

- `npx vite build` 성공(3회).
- `classifyHistory({RETURN, before:'상태:퇴원', after:'상태:재원, 반:HA103 …'})` → `{label:'재등원',from:'퇴원',to:'재원'}` 확인.
- `deriveTenure([ENROLL→WITHDRAW→RETURN])` → startEvent=재등원일, end=null(진행중) — 03-12 고정 해소(이슈3 동반 개선).
- 정상 재원생 수업추가(B의 isReEnroll=false / D·E의 enrollable): 기존 UPDATE 동작 무영향.
- 심예율 등 기존 데이터: 미수정.

## 후속(범위 밖)
- DSC parity: DSC에는 재등록 폼/문법특강 일괄경로가 없어 동일 취약점 없음(이미 G·CF 경유). 단 DSC가 향후 동일 폼 도입 시 같은 가드 필요 — 메모만.
- 경로 D는 현재 UI 호출처 없음(dead). 추후 재노출 시 가드가 선제 방어.
