---
name: impact7-orchestrator
description: "impact7 에코시스템(DB/DSC/HR/exam) 통합 운영 오케스트레이터. 기능 개발, 버그 수정, 데이터 모델 변경, 리팩토링 등 4개 앱에 걸친 모든 개발 작업을 조율한다. '기능 추가', '버그 수정', '필드 변경', '컬렉션 추가', '마이그레이션', '크로스앱 변경' 요청 시 사용. 후속 작업: 결과 수정, 부분 재실행, 업데이트, 보완, 다시 실행, 이전 결과 개선 요청 시에도 반드시 이 스킬 사용. 단순 질문이나 단일 앱 내 소규모 변경은 직접 처리 가능."
---

# impact7 Orchestrator

impact7 에코시스템(DB/DSC/HR/exam)의 에이전트를 조율하여 크로스앱 개발 작업을 안전하게 수행하는 통합 오케스트레이터.

## 실행 모드: 서브 에이전트

## 에이전트 구성

| 에이전트 | subagent_type | 역할 | 호출 조건 |
|---------|--------------|------|----------|
| impact-analyst | impact-analyst | 크로스앱 영향 분석 | 항상 (Phase 1) |
| db-developer | db-developer | impact7DB 구현 | DB 영향 시 |
| dsc-developer | dsc-developer | impact7newDSC 구현 | DSC 영향 시 |
| hr-developer | hr-developer | impact7HR 구현 | HR 영향 시 |
| exam-developer | exam-developer | impact7exam 구현 | exam 영향 시 |
| qa-validator | qa-validator | 크로스앱 정합성 검증 | 2개+ 앱 변경 시 |

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `_workspace/` 디렉토리 존재 여부 확인
2. 실행 모드 결정:
   - **`_workspace/` 미존재** → 초기 실행. Phase 1로 진행
   - **`_workspace/` 존재 + 부분 수정 요청** → 부분 재실행. 해당 에이전트만 재호출
   - **`_workspace/` 존재 + 새 입력** → 새 실행. 기존 `_workspace/`를 `_workspace_{timestamp}/`로 이동

### Phase 1: 영향 분석

impact-analyst 에이전트를 호출하여 크로스앱 영향을 분석한다.

```
Agent(
  description: "크로스앱 영향 분석",
  subagent_type: "impact-analyst",
  model: "opus",
  prompt: "다음 작업의 크로스앱 영향을 분석하라: {사용자 요청 요약}.
    결과를 _workspace/01_impact_analysis.md에 저장하라."
)
```

**분석 결과 확인:**
- `_workspace/01_impact_analysis.md`를 Read로 읽는다
- 영향받는 앱 목록과 위험도를 파악한다
- 위험도가 "높음" 이상이면 사용자에게 분석 결과를 보여주고 진행 확인을 받는다

### Phase 2: 구현

영향받는 앱별로 전문 개발자 에이전트를 호출한다. 영향받는 앱이 2개 이상이면 `run_in_background: true`로 병렬 호출한다.

```
// 영향받는 앱이 DB + DSC인 경우 예시
Agent(
  description: "impact7DB 구현",
  subagent_type: "db-developer",
  model: "opus",
  run_in_background: true,
  prompt: "다음 영향 분석을 기반으로 impact7DB를 수정하라:
    [_workspace/01_impact_analysis.md의 DB 관련 내용]
    구체적 작업: {구현 지시}"
)

Agent(
  description: "impact7newDSC 구현",
  subagent_type: "dsc-developer",
  model: "opus",
  run_in_background: true,
  prompt: "다음 영향 분석을 기반으로 impact7newDSC를 수정하라:
    [_workspace/01_impact_analysis.md의 DSC 관련 내용]
    구체적 작업: {구현 지시}"
)
```

**구현 순서 규칙:**
- students 스키마 변경 시: DB(마스터) 먼저 → 이후 DSC/exam 병렬
- Rules 변경 필요 시: 구현 완료 후 `/firestore-rules-sync` 스킬 호출
- 단일 앱 변경: 해당 개발자만 호출 (병렬 불필요)

### Phase 3: 검증 (조건부)

2개 이상 앱이 변경되었을 때만 qa-validator를 호출한다.

```
Agent(
  description: "크로스앱 정합성 검증",
  subagent_type: "qa-validator",
  model: "opus",
  prompt: "다음 변경의 크로스앱 정합성을 검증하라:
    영향 분석: _workspace/01_impact_analysis.md
    변경된 앱: {목록}
    결과를 _workspace/03_qa_report.md에 저장하라."
)
```

**QA 실패 시:**
- 실패 항목을 해당 앱 개발자에게 전달하여 수정
- 수정 후 QA 재실행 (최대 2회)

### Phase 4: 정리 및 보고

1. Rules 변경이 있었으면 4개 프로젝트 동기화 확인
2. 각 앱의 빌드 성공 확인 (변경된 앱만)
3. `_workspace/` 보존
4. 사용자에게 결과 요약:
   - 변경된 앱과 파일 목록
   - QA 결과 (해당 시)
   - 빌드 상태
   - 배포 안내 (push 시 자동 배포됨)

## 데이터 흐름

```
[사용자 요청]
    ↓
[impact-analyst] → _workspace/01_impact_analysis.md
    ↓ (분석 결과 확인)
[app-developers] → 코드 변경 (병렬)
    ↓ (2개+ 앱 변경 시)
[qa-validator] → _workspace/03_qa_report.md
    ↓
[결과 보고]
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| impact-analyst 실패 | 1회 재시도. 재실패 시 수동 분석으로 전환 |
| 개발자 에이전트 1개 실패 | 1회 재시도. 재실패 시 해당 앱 변경 보류, 나머지 진행 |
| qa-validator 실패 | 수동 검증 안내 |
| 빌드 실패 | 해당 앱 개발자 재호출하여 수정 |
| Rules 동기화 실패 | `/firestore-rules-sync` 스킬 수동 호출 안내 |

## impact7DB 모듈 분리 규칙

impact7DB의 app.js(~6000줄)는 점진적 분리 중이다. db-developer 에이전트 호출 시 이 규칙을 프롬프트에 포함하라:
- **새 기능은 app.js에 추가하지 않는다** — 별도 `.js` 모듈로 작성
- 기존 코드 수정 시 해당 블록의 분리를 검토한다

## 단일 앱 변경 최적화

영향 분석 결과 단일 앱만 영향받고 위험도가 "낮음"이면:
- QA 건너뛰기
- 해당 앱 개발자만 호출
- 빌드 확인 후 바로 보고

## 테스트 시나리오

### 정상 흐름: students 필드 추가 (다중 앱)
1. 사용자: "students에 nickname 필드 추가해줘"
2. Phase 1: impact-analyst가 DB(쓰기) + DSC/exam(읽기) 영향 파악
3. Phase 2: db-developer가 app.js 수정 → dsc-developer/exam-developer가 읽기 코드 확인
4. Phase 3: qa-validator가 필드명 일관성 + rules 확인
5. Phase 4: 빌드 확인, 결과 보고

### 에러 흐름: 빌드 실패
1. Phase 2에서 db-developer가 구문 에러 포함 코드 생성
2. 빌드 실패 감지
3. db-developer 재호출하여 에러 수정
4. 빌드 재확인 → 성공
5. Phase 3으로 진행
