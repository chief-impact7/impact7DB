# 심예율 핸드오프 3이슈 — Code Review

대상: DB `e9b8402..HEAD` (`03df0b9`/`693c1f1`/`84cf5a3`), shared `v1.16.0..v1.17.0` (`8668825`), DSC `fillTenure`.
방침: 리뷰·발견만, 코드 미수정.

---

## 이슈 1 — `branchFromClassNumber` csKey 접두 인식 (`app.js:247-256`)

### F1-1. csKey 접두 가정은 데이터상 성립 (확인됨, 발견 아님) — info
- `buildNaesinCsKey`(DSC `student-helpers.js:106`)는 `branch`를 포함하지만, **자동유도 경로 `deriveNaesinCode`(141)는 `branch` 없이 호출**한다. 그러나 실제 csKey를 만드는 `resolveNaesinCsKey`(153)는 두 경로 모두에서 branch를 보장한다:
  - override 경로: 저장된 문자열을 그대로 반환 (마법사 `class-setup.js:822`가 `branch` 포함해 생성).
  - 자동유도 경로: `branchFromStudent(student) + nCode`(161)로 **항상 branch 접두**.
- DSC `branchFromStudent`는 `branch` 필드(=`2단지`/`10단지`) 우선이므로 csKey 접두는 사실상 `2단지`/`10단지`뿐. DSC `check-orphan-cssettings.mjs`의 `VALID_NAESIN_RE = /^(2단지|10단지).+(초|중|고)[1-3][AB]$/`가 이 불변식을 강제. → **fix의 접두 가정은 현재 데이터·코드와 정합.**
- **단, 잠재 위험(major 후보):** `branch` 필드가 비어 자동유도되면 `branchFromStudent(student)=''` → csKey 접두 없는 `마포고1A` 생성 가능. 그 csKey가 정규로 활성치환되어 `branchFromClassNumber('마포고1A')`로 들어가면 두 접두 모두 불일치 → 첫 글자 `'마'` → `return ''`. **오표시(10단지)는 안 나지만 "소속 미표시"가 됨.** 빈 문자열 fallback `s.branch`도 비어있으니 표시 공백. 발생 조건은 좁음(branch 필드 결손 + 내신 활성)이나 가능. 심각도 **minor** (오표시 아닌 공백, 이미 데이터 결손 전제).

### F1-2. 접두 순서·정규 반번호 오인 가능성 없음 — info (정상)
- `startsWith('10단지')`를 `startsWith('2단지')`보다 먼저 체크 — `10단지`는 `2단지`로 시작 안 하므로 순서 무관하나 명시적이라 안전.
- 정규 반번호는 숫자 문자열(`103`,`205`)이라 `'2단지'`/`'10단지'` startsWith 불가 → 핸드오프 우려대로 오인 없음. `103→2단지`, `205→10단지` 유지 확인.

### F1-3. 전 호출처에 일관 반영 — info (정상)
- 수정이 `branchFromClassNumber` 내부라 `branchFromStudent`/`branchesFromStudent`/`activeBranchesFromStudent` 모두 자동 교정.
- `branchesFromStudent`(262)는 raw `s.enrollments`(정규 `103`)를 보고 `activeBranchesFromStudent`(336)는 파생 내신 csKey를 봄. 수정 후 심예율은 양쪽 `{2단지}`로 **일치** → 클래스필터 사이드바(1096, raw 기반)와 메인리스트 단지필터(1181, 파생 기반)의 **기존 불일치가 오히려 해소됨**. 회귀 없음.

---

## 이슈 2 — 퇴원/종강/상담 재등원 가드 (`app.js:2489·3122·6091`)

### F2-1. B경로 `isReEnroll`의 `mergeData.status` 출처 — info (정상)
- `mergeData.status = _newStatusForCreate || existingStudent.status || '상담'`(2474). `_newStatusForCreate`는 신규수업 있을 때 `f.status?.value || '등원예정'`(2351), 없으면 `'상담'`. 즉 **폼 입력값이며, 신규 enrollment가 있을 때만 재원계열**이 됨. `isReEnroll`이 `_newEnrollmentsForCreate.length>0`을 함께 요구(2494)하므로 "수업 없이 status만 재원" 무단 전이는 구조적으로 불가. → 의도대로.

### F2-2. RETURN 로그가 `classifyHistory`에서 재등원으로 분류됨 — info (검증)
- before=`상태:퇴원`, after=`상태:재원, 반:… (재등원…)`, change_type=`RETURN`.
- `classifyHistory`: RETURN은 특수분기 아님 → `parseStatusClass`로 bS=`퇴원`, aS=`재원` → L80 `bS==='퇴원' && aS==='재원'` → **재등원**. `deriveTenure`가 startEvent로 인식. 확인 완료.
- L71 "재입력+수업+추가" 분기는 after에 `재입력`이 없어 미발동(after는 `재등원 + 수업 N건 추가`) → 중복분류 없음. OK.

### F2-3. **after 텍스트의 `반:` 파싱 오염 — minor**
- after=`상태:재원, 반:HA103, GR901 (재등원 + 수업 1건 추가)`처럼 **enrollment가 2개 이상이면 `reEnrollCodes`에 콤마 포함**(2497 `.join(', ')`). `parseStatusClass`의 반 정규식 `반[:\s]*([^,]*?)(?:,\s*요일|$)`는 첫 콤마 직전까지만 잡아 `classes=HA103`만 추출(나머지 `GR901 (재등원…)`은 status 파싱에도 안 걸림). 분류(재등원)는 status로 결정되므로 **tenure·badge에는 무영향**. 단 history 상세에서 반코드 표기가 불완전. 심각도 minor(표시 한정).

### F2-4. D경로 차단 vs rules 정합 — info (정상, 부당차단 아님)
- `saveEnrollment`는 status를 쓰지 않고 `{enrollments, branch}` merge만(3132). post-merge status가 퇴원/종강/상담으로 남고 enrollments≠0 → rules `enrollmentStatusConsistent`(firestore.rules:84, **request.resource 기준 = 결과 status**) **거부**. 즉 가드 추가 전에도 rules가 막던 동작 → 가드는 permission-denied를 친절메시지로 대체할 뿐 **정상 흐름 차단 아님**. 상담생 정식 등록은 B경로(submitNewStudent)로 가므로 무영향.

### F2-5. **E경로(일괄) status 결손 학생 미커버 + 배치 원자성 — major**
- 가드(6093)는 `existingS && NON_ENROLLABLE_STATUSES.has(existingS.status)`만 스킵. **`status` 필드가 없는 레거시 학생**은 `has(undefined)=false` → 스킵 안 됨 → enrollment append. post-merge status=`''` → rules `enrollmentStatusConsistent`(get('status','')→'') **거부** → `batch.commit()` 실패 → **해당 200개 청크 전원 롤백**(다른 정상 학생까지 저장 실패). 무로그 전환 위험은 없으나 일괄저장 가용성 훼손. 가드 조건을 "재원계열이 아니면 스킵"(`!ENROLLABLE_STATUSES.has(status)`)으로 바꾸면 status 결손까지 커버됨.
- 부수: `savedCount = toSave.length - skippedWithdrawn.length`(6174)는 위 rules거부로 throw되면 무의미(catch로 빠짐). 정상 케이스 카운트는 정확.

### F2-6. E경로 로컬 캐시 선반영 — minor (기존 위험, 본 변경 무관)
- 신규학생 `allStudents.push`(6153)·기존학생 로컬 mutation(6127-6129)이 `batch.commit()`(6169) **이전**에 일어남. commit 실패 시 phantom/불일치 로컬 상태 잔존. 본 PR이 만든 버그는 아니나 F2-5의 청크 롤백과 결합하면 표면화. 심각도 minor.

### F2-7. enrollment↔status 정합성 위반 없음 — info
- 세 경로 모두 비원생→enrollment 직결을 막거나(D/E) 재등원으로 status를 재원계열로 동반전이(B)시켜 `[[feedback_enrollment_status_consistency]]` 불변식 유지. STATUS_CHANGE 로그 JSON(`{status}`)은 `parseStatusClass` JSON 분기(34-43) 및 `classifyHistory` L61(STATUS_CHANGE→null 무시)와 호환.

---

## 이슈 3 — `deriveTenure(…, isCurrentlyEnrolled)` + DB/DSC `fillTenure` (shared `8668825`)

### F3-1. 휴원계열 end=null 의미 — minor (설계 판단)
- `ENROLLABLE_STATUSES`는 실휴원/가휴원 포함. 휴원 학생이 과거 퇴원 로그를 가지면 `isCurrentlyEnrolled=true` → end=null → `formatTenure`가 `~ 현재` 표기(휴원은 종강 분기 아님). "휴원 중인데 재원기간이 현재진행"으로 보일 수 있음. 다만 휴원은 재원관계 유지 상태라 tenure 미종료는 **방어 가능한 해석**. 의도라면 OK, 아니면 "재원/등원예정만 end무효"로 좁혀야 함. 심각도 minor(설계 합의 필요).

### F3-2. start가 실제 재등원보다 이를 수 있는 한계 — minor (문서화된 허용)
- 무로그 재등원은 startEvent를 옛 신규(03/12)로 잡음 → `start`=03/12 이후 **첫** 출석. 직전 stint(퇴원 전)의 출석이 03/12 이후에 있으면 그 날이 start가 되어 실제 재등원일보다 이를 수 있음. 핸드오프가 "허용 가능"으로 명시한 한계. 이슈2 가드가 향후 무로그 전환을 막아 신규 발생은 차단됨. **존재 데이터는 잔존**. 심각도 minor(known limitation).

### F3-3. `start > end` 역전 — info (해당 없음)
- end=null이면 무관. end 유지 케이스(비원생)는 본 변경이 건드리지 않음(`isCurrentlyEnrolled=false`). 역전 신규 발생 없음.

### F3-4. DB↔DSC parity — info (정상, 동치)
- DB `ENROLLABLE_STATUSES.has(studentData.status)`(app.js:4413) ≡ DSC `isEnrollableStatus(student.status)`(student-detail.js:120) — 후자는 전자의 래퍼(enrollment-status.js:9-11). `formatTenure` 종강 분기도 양 앱 동일(DB 4431 / DSC 88). 양쪽 `package.json` v1.17.0 핀 확인.

### F3-5. 하위호환 — info (정상)
- 4번째 인자 `= false` 기본값. 기존 호출(테스트 84-129 포함)·shared 외부 소비처는 false로 동작해 거동 불변. 테스트 82pass, 신규 케이스(132-151)가 true/false 양분기 커버.

---

## 심각도별 건수
- critical: 0
- major: 1 (F2-5 E경로 status 결손 미커버 → 청크 롤백) + 1 잠재(F1-1 branch 결손 시 csKey 접두 누락, 다만 표시공백 수준이라 minor로도 분류 가능)
- minor: 5 (F1-1 공백, F2-3 반파싱, F2-6 로컬선반영, F3-1 휴원 end, F3-2 start 한계)
- info/정상: 다수

## 핵심 5줄
1. **이슈1·3은 견고**: csKey 접두 가정은 `resolveNaesinCsKey`+`VALID_NAESIN_RE` 불변식과 정합, 정규 반번호 오인 없음. deriveTenure parity(DB≡DSC)·하위호환·테스트 모두 OK.
2. **F2-5(major)**: 문법특강 일괄저장 가드가 `status` 결손 레거시 학생을 못 거르면 rules거부로 **200개 청크 전원 롤백**. `!ENROLLABLE_STATUSES.has(status)`로 조건 전환 권장.
3. **이슈2 가드 자체는 정상**: D경로 차단은 원래 rules가 막던 동작이라 부당차단 아님, B경로 RETURN 로그는 classifyHistory에서 재등원으로 정확 분류됨.
4. **minor 다수**: 다중 enrollment 시 `반:` 파싱 오염(표시 한정), 휴원계열 end=null 의미(설계 합의 필요), 무로그 start가 실제 재등원보다 이를 수 있는 기존 한계(문서화됨).
5. **권장**: F2-5만 우선 수정, 나머지 minor는 합의/관찰 대상. critical 없음.
