# collectionGroup students 인덱스 + 이력 쿼리 전환 (2026-07-05)

## 사실
- exam 성적 이력(results/[studentId])은 **서버 라우트(/api/results/history, Admin SDK)**가 `collectionGroup('students').where('studentId','==',X)`로 조회. impact7DB에서 studentId fieldOverride(COLLECTION_GROUP ASC) 배포 완료(a514a7b).
- 'students' 이름 컬렉션은 3곳: 최상위 마스터 / results/*/students / external_score_events/*/students. **external 문서도 studentId 필드 보유** → 소비자는 반드시 `ref.path.startsWith('results/')` 필터.

## 불변식
- **rules에 `/{path=**}/students` 와일드카드 read를 추가하지 않기로 결정** — 서버 Admin SDK 경유라 불필요하고, 추가하면 미래에 'students' 이름 서브컬렉션이 생길 때마다 전 직원 read가 자동 개방되는 함정(적대 리뷰 LOW-6). 클라이언트 CG 쿼리가 필요해지면 그때 명시 설계.
- result 문서 ID==studentId 레거시 관례는 **존재하지 않음**(최초부터 auto-ID) — ID에서 studentId 유도는 s_* 결정적 ID만 허용. 백필은 기존 truthy 값 절대 불변.
- results write에 `studentId ?? ''` 일괄 주입 금지 — merge가 기존 올바른 값을 ''로 덮음. undefined는 래퍼 drop으로 보존, 명시적 ''는 Step4Review 매칭 해제 신호로 예약.

## 운영 교훈
- **firestore.indexes.json 배포 전 `firebase firestore:indexes`로 라이브와 diff 확인** — 파일이 라이브 대비 6건 누락 drift 상태였음(HR fieldOverride 3 + exam_review_jobs TTL + 복합 2). 역병합 후 배포로 삭제 사고 예방.
- CG 단일필드 인덱스 빌드는 컬렉션 그룹 전체(마스터 1.5만 포함) 스캔이라 배포 후 수 분 소요 — FAILED_PRECONDITION 프로브로 준비 확인 후 소비 코드 배포.
- 백필 실데이터(71건): 매칭 가능분은 이미 필드 보유(27), 나머지는 미확인 학생·삭제 시험 잔존물 — 자동 매칭 불가가 정상.
