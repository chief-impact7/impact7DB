# QA 리포트: exam 컬렉션 역할 기반 write 제한 (2026-07-05)

변경 앱: impact7DB(firestore.rules SSoT + 테스트) / impact7exam(설정 화면 owner 게이트, 미커밋)

## 크로스앱 경계면 검증 (10-앵글 리뷰 + 스윕으로 수행)

| 경계면 | 결과 |
|--------|------|
| rules isExamMember ↔ exam 클라 write 전 경로 | ✅ 일치 — useResults/useOcrGrading/useExam/useExternalScores/useExamSets/notifications/placement/grading 전부 프로비저닝된 teacher/owner 주체. ensureUserProfile(useAuth.ts:45-59)이 setDoc await 후 UI 렌더 → 첫 write race 없음 |
| rules isExamOwner ↔ exam 프론트 게이트 | ✅ 동일 소스(exam_users.role=='owner') — nav-config `ownerOnly:true` + OwnerOnly.tsx 페이지 가드가 departments/exam-types 양쪽 커버. DashboardGuard가 user 확정 전 렌더 차단(깜빡임 없음) |
| answer_keys/exam_templates client write=false | ✅ 안전 — 전 write가 Next API route→adminDb (2개 앵글 독립 확인, client write 0건) |
| exam_analyses isExamMember 조임 | ✅ 안전 — write 전부 서버(repository.ts adminDb) 경유, 클라 직접 write 0건. 순수 심층 방어 |
| collectionGroup 의존 | ✅ 없음 — students 서브컬렉션 read는 직접 경로만 |
| 타 앱(DB/DSC/HR/DashBoard/tablet/qbank) 영향 | ✅ 없음 — 대상 컬렉션 클라 접근 0건. impact7DB functions·qbank는 Admin SDK(rules 우회) |
| exam_users hoist 회귀 | ✅ 기존 exam-users 테스트 10건 전부 통과, 로컬→전역 헬퍼 동작 동치 확인 |

## 에뮬레이터 테스트
- exam 관련 3파일 37/37 통과 (신규 exam-role-write 19건 포함)
- 전체 스위트 137/140 — 실패 3건은 HEAD에서도 동일한 기존 personnel stale 테스트(계약서명 callable 이관 e93f290·shortterm PII 제거 9f6d40e에 미갱신)로 이번 변경과 무관

## 잔여 위험 / 후속
1. **배포 창**: rules 배포 후 exam 앱 push 전까지 teacher에게 설정 화면이 보이나 저장은 거부(게이트는 push 시 배포됨). 낮은 빈도 화면이라 영향 제한적.
2. exam_users 프로비저닝 실패 시 fail-closed(write 잠김, 재로그인으로 복구) — 의도된 방향.
3. 후속 후보: personnel stale 테스트 3건 정리, exam_analyses admin 클레임 죽은 분기 정리, externalCtx 테스트 헬퍼 승격.
