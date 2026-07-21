# DB 검색 전체 대상 원칙 (2026-07-21)

사용자 지시: **"DB(마스터)는 어떠한 경우라도 모든 데이터를 다 보여줘야 함."**

## 계기 — 서이수 사건
상담생 서이수(`students/서이수_1037912053`, 중등2, enrollments [])가 DSC엔 보이는데 DB 검색 0명. 데이터는 마스터에 정상 존재 — DB 프론트 필터 3중 차단이 원인:
1. 중등 학기 롤오버(2026-07-20) cutoff — 상담/퇴원/종강은 updated_at ≥ 학기시작일만 기본뷰 표시 → "전체에서 검색"도 무력
2. 학기 드롭다운의 semester 필터가 칩에 안 보인 채 잔존(sticky) → enrollments 빈 상담생 전원 탈락
3. searchPastStudents 폴백이 퇴원/종강만 커버, 상담 누락 + status 네비에 '상담' 항목 부재

## 적용된 설계 결정 (app.js)
- **검색어가 있으면 모든 activeFilters·학기cutoff 무시, allStudents 전체 검색.** 배너 "검색 중 필터 일시중지 — 전체에서 검색 중" (DSC와 동등). "전체에서 검색" 버튼 제거.
- **검색 중엔 특수 뷰(그룹뷰/휴원예정뷰) 우회, 항상 기본 2계층 렌더** — 필터 전제 섹션 분류가 어긋나므로 (codex 리뷰 발견).
- **상담 status는 기본뷰 cutoff 면제** (상담 60명 / 퇴원 15,327명 — 퇴원·종강 cutoff는 유지). ACTIVE_STUDENT_STATUSES(shared 계약)는 미수정, app.js에 `|| st === '상담'` 분기만.
- **status 네비에 '상담' 항목 추가** (index.html).
- searchPastStudents/PAST_STUDENT_STATUSES/pastResults 경로 삭제 — 검색이 전체 대상이 되면서 중복.

**Why:** 마스터 DB에서 "찾을 수 없는 학생"은 마스터 역할 부정. 검색은 뷰가 아니라 조회 — 필터는 브라우징 개념.

**How to apply:** DB 검색·필터 로직 수정 시 이 원칙 유지. 새 status 추가 시 기본뷰 노출 여부는 건수 규모로 판단(cutoff는 대량 status 전용). 관련: [[feedback_db_dsc_parity]] — DSC도 검색 시 필터 일시중지 동작, 양쪽 동등 유지.
