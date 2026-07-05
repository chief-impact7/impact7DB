# exam 컬렉션 역할 기반 write 제한 (2026-07-05, 9c842cf)

## 불변식 (되돌리기 금지)
- **exam 역할 소스는 `exam_users/{uid}.role`** (값: owner/teacher 2종). HR_users(getUserRole)를 exam 컬렉션 규칙에 쓰지 말 것 — 채점 교사는 HR_users 문서가 없을 수 있어 무조건 거부됨.
- **`results/{examId}/students`를 owner 전용으로 조이지 말 것** — OCR 채점은 teacher가 client SDK로 직접 write(useResults/useOcrGrading/placement/grading). owner 전용화 = 채점 마비.
- `examUserRole()`은 exists() 가드 + `data.get('role','')` — 문서 부재든 role 필드 부재든 평가 에러 없이 clean deny. 이 이중 가드를 제거하지 말 것.
- exam_users owner write는 `role in ['teacher','owner']` 스키마 강제 — owner가 role 오타/누락 문서를 만들면 그 계정의 exam write 전체(채점 포함)가 잠기는 사고 예방.
- answer_keys/exam_templates/exam_analyses write는 전부 Next API route→Admin SDK 경유(client write 0건, 2026-07-05 전수 확인). client write 규칙은 false/isExamMember 심층 방어.

## 적용 구조
- 채점·운영(exams, results/*/students, external_score_events(+students), exam_notifications, exam_sets, exam_analyses) = isExamMember()(teacher 이상)
- 설정성(departments, examTypes) = isExamOwner() — exam 프론트 OwnerOnly 게이트(nav-config `ownerOnly` + OwnerOnly.tsx)와 짝. 게이트와 rules 모두 같은 exam_users.role 소스.
- 테스트: tests/firestore.rules.exam-role-write.test.js (에뮬레이터 19건)

## 미해결 (2026-07-05 기준)
- personnel rules 테스트 3건 stale 실패 — e93f290(계약 서명 callable 이관)·9f6d40e(shortterm PII 제거) 보안 커밋에 맞춰 미갱신. 이번 변경과 무관, 정리 필요.
- exam_analyses update/delete의 `request.auth.token.admin` 클레임 분기는 프로비저닝 경로 없는 죽은 분기 — 후속 정리 후보(isExamOwner 대체 또는 제거).
- exam 앱 owner 게이트 프론트는 커밋/푸시 대기 — rules 먼저 배포된 상태라 push 전까지 teacher에게 설정 화면이 보이나 저장은 거부.
