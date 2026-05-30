# 44. DSC 재원기간 status 보정 parity (이슈3 DSC 측)

DB 핸드오프 이슈3의 DSC parity. shared `deriveTenure`에 4번째 인자 `isCurrentlyEnrolled`가 추가된 v1.17.0(현재 status 재원계열인데 history 마지막이 퇴원이면 `end=null` 보정 — 무로그 재등원 교정)을 DSC에도 적용. [[feedback_db_dsc_parity]]

## 작업

### 1. 의존성 bump · 재설치 확인
- `impact7newDSC/package.json`: `@impact7/shared` `#v1.16.0` → `#v1.17.0`
- `node_modules/@impact7/shared` 삭제 후 `npm install @impact7/shared --prefer-online` 재설치
  (`npm cache clean --force`는 sandbox 권한 에러 → `--prefer-online`로 github 캐시 우회)
- 반영 검증:
  - `grep -c isCurrentlyEnrolled node_modules/@impact7/shared/history-classifier.js` → **2** (≥1 충족)
  - signature: `deriveTenure(logs, getDate, attendances, isCurrentlyEnrolled = false)`
  - 보정 라인: `if (end && isCurrentlyEnrolled) end = null;`

### 2. fillTenure 호출 수정 (`impact7newDSC/student-detail.js` ~L116)
4번째 인자 추가:
```js
const { start, end, startEvent } = deriveTenure(
    logs,
    (l) => l.timestamp?.toDate ? ... : ...,
    attendances,
    isEnrollableStatus(student.status)   // 추가
);
```

### 3. import 확인 (추가 import 불필요)
- DSC는 이미 L13에서 `isEnrollableStatus`(`@impact7/shared/enrollment-status`)를 import 중.
- shared에서 `isEnrollableStatus(s)` === `ENROLLABLE_STATUSES.has(s)` (둘 다 export, 동일 Set `재원/등원예정/실휴원/가휴원`). DB가 권장한 `ENROLLABLE_STATUSES.has(student.status)`와 의미 동일 → 기존 import 재사용해 새 import 없이 처리.

### 4. 검증
- `npm run build` (Vite): 성공 (13.13s, 에러 0).
- `npm test`: 19 pass / 0 fail (tenure 무관 consultation 테스트만 존재, 회귀 없음 확인).
- 논리: 무로그 재등원생(현재 status 재원계열, history 마지막 분류 `퇴원`) → `isEnrollableStatus(status)=true` → `end=null` → 첫 출석~현재로 표시. 정상 퇴원생(status `퇴원/종강`) → `false` → `end` 유지. DB app.js와 동일 SSoT.

## 제약 준수
커밋·푸시·배포 안 함. shared repo 미수정. 데이터 미수정.

## 변경 파일
- `impact7newDSC/package.json` (v1.16.0→v1.17.0)
- `impact7newDSC/student-detail.js` (fillTenure deriveTenure 4번째 인자)
- `impact7newDSC/package-lock.json` (재설치 반영)
