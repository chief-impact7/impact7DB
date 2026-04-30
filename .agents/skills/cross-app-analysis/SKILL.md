---
name: cross-app-analysis
description: "impact7 에코시스템(DB/DSC/HR/exam) 크로스앱 영향 분석. Firestore 컬렉션 변경, 스키마 수정, 공유 데이터 모델 변경 시 어떤 앱이 영향받는지 분석한다. '영향 분석', '어디 영향', '어떤 앱이 바뀌나', '크로스앱' 등의 요청 시 사용."
---

# 크로스앱 영향 분석

이 스킬은 impact-analyst 에이전트를 호출하여 크로스앱 영향을 분석한다.
분석 절차, 위험도 판정표, 컬렉션 맵, 출력 형식은 모두 에이전트 정의에 있다.

## 실행 방법

```
Agent(
  description: "크로스앱 영향 분석",
  subagent_type: "impact-analyst",
  model: "opus",
  prompt: "다음 작업의 크로스앱 영향을 분석하라: {사용자 요청}.
    결과를 _workspace/01_impact_analysis.md에 저장하라."
)
```

오케스트레이터 없이 독립 호출 시에도 동일하게 impact-analyst 에이전트를 사용한다.
