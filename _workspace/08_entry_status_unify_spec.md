# DB 구현 스펙 — 진입 상태 '등원예정' 단일화 + 버튼 정리

목표: 비원생→재원생 진입을 모두 '등원예정' 경유로 통일하고, promoteEnrollPending이 날짜 도래 시 자동 '재원' 전환. 휴먼에러(등원예정 vs 재원 수동선택) 제거. **공유모듈·rules·마이그레이션 변경 없음. DB(필요 시 DSC) 코드만.**

## #1 — 퇴원 학생 헤더 '재등록' 버튼 제거
- 현재 `app.js:1790`: 비활성(퇴원/종강/상담)이면 `reenroll-btn` 표시.
- 변경: **퇴원은 숨김** (퇴원은 퇴원요청서 카드의 **재등원요청서**로만 복귀). 상담/종강은 헤더 버튼 유지.

## #2 — 헤더 버튼 라벨 상태별 분기
- **상담 → "신규등록"** (한 번도 재원이 아니었으므로 재등록은 부적절).
- **종강 → "재등록"** (과거 재원생이므로 현행 유지).
- 퇴원 → 버튼 없음(#1).
- index.html `reenroll-btn` 텍스트 + app.js `selectStudent`에서 status에 따라 동적 라벨/표시.

## #3 — 신규등록 폼 status 기본값 '등원예정' (재원 선택은 유지)
- `INITIAL_STATUSES`/`selectableStatuses`는 **건드리지 말 것**(재원 옵션 유지).
- 폼 status select의 **기본 선택값만 '등원예정'**으로. 현재 첫 옵션이 등원예정이면 OK지만, 저장 폴백 `app.js:2230`의 `|| '재원'`도 `|| '등원예정'`로 맞춰 일관성 확보. 운영자가 원하면 재원 수동 선택 가능.

## #4 — 재등원/복귀 승인 적용 시 '등원예정' + 복귀일 (가장 주의)
- 현재: 복귀/재등원이 적용되면 status를 **'재원' 직접** 세팅(폼 저장 `isReturnToActive` 분기 app.js~2280, 그리고 return modal 제출 경로). 
- 변경: **status='등원예정'**으로 세팅하고, **target 반 enrollment의 start_date = 복귀일(return_date)**로 설정 → `promoteEnrollPending`이 복귀일에 자동 '재원' 전환.
  - 복귀일이 오늘이면 promote가 **즉시 재원**(같은날 복귀 정상 동작). 미래면 그날까지 등원예정.
  - **⚠️ 핵심: enrollment.start_date를 복귀일에 반드시 연결.** 안 하면 promote가 안 돌아 영원히 등원예정에 묶임. 현재 복귀일을 어디에 쓰는지(return_date/start_date) 확인해 enrollment.start_date로 물릴 것.
- 실제 적용 지점을 찾아 정확히 수정하고, **무엇을 어떻게 바꿨는지 보고**.

## 제약·보고
- `promoteEnrollPending`(app.js:528) 동작·기존 enrollment 활성 판정(start_date≤today) 깨지 말 것. 수정(편집) 모드의 재원 선택은 데이터 정정용으로 **유지**.
- enrollment↔status 정합성(등원예정은 enrollment≥1)을 복귀 enrollment가 충족하는지 확인.
- `npx vite build` 성공. **커밋·푸시 금지** — 보고만.
- **DSC 관여 확인**: 복귀/재등원 승인이 **DSC에서도 학생 status를 세팅**하는지(leave-request.js 등) 조사해서 보고. DSC도 세팅하면 동일 변경 필요 → 알려줄 것(이번엔 DB만, DSC는 후속).
- 보고서를 `_workspace/09_entry_status_unify_impl.md`에 저장.
