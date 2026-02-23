# Firestore Security Rules - Test Scenarios

## 테스트 도구
Firebase Emulator Suite 또는 Firebase Console Rules Playground 사용

```bash
# 에뮬레이터 실행
firebase emulators:start --only firestore
```

---

## 1. 인증 (isAuthorized)

### 1.1 PASS: 유효한 도메인 계정
- auth: `{ uid: "user1", email: "teacher@gw.impact7.kr", email_verified: true }`
- action: `get /students/test_doc`
- expected: ALLOW

### 1.2 PASS: 두 번째 도메인 계정
- auth: `{ uid: "user2", email: "admin@impact7.kr", email_verified: true }`
- action: `get /students/test_doc`
- expected: ALLOW

### 1.3 FAIL: 인증 없음
- auth: null
- action: `get /students/test_doc`
- expected: DENY

### 1.4 FAIL: 이메일 미인증
- auth: `{ uid: "user3", email: "teacher@gw.impact7.kr", email_verified: false }`
- action: `get /students/test_doc`
- expected: DENY

### 1.5 FAIL: 허용되지 않은 도메인
- auth: `{ uid: "user4", email: "hacker@gmail.com", email_verified: true }`
- action: `get /students/test_doc`
- expected: DENY

### 1.6 FAIL: 도메인 서픽스 공격
- auth: `{ uid: "user5", email: "evil@gw.impact7.kr.attacker.com", email_verified: true }`
- action: `get /students/test_doc`
- expected: DENY ($ 앵커로 차단)

---

## 2. Students 컬렉션

### 2.1 CREATE - PASS: 필수 필드 포함
```json
{
  "name": "김민준",
  "parent_phone_1": "01012345678",
  "branch": "2단지",
  "status": "재원",
  "enrollments": [{"class_type": "정규", "level_symbol": "HA", "class_number": "101", "day": ["월","수"], "start_date": "2026-01-15"}],
  "level": "초등",
  "school": "진명초등학교",
  "grade": "3"
}
```
- expected: ALLOW

### 2.2 CREATE - FAIL: name 누락
```json
{
  "parent_phone_1": "01012345678",
  "branch": "2단지",
  "status": "재원",
  "enrollments": []
}
```
- expected: DENY

### 2.3 CREATE - FAIL: status enum 위반
```json
{
  "name": "김민준",
  "parent_phone_1": "01012345678",
  "branch": "2단지",
  "status": "잘못된상태",
  "enrollments": []
}
```
- expected: DENY

### 2.4 CREATE - FAIL: 허용되지 않은 필드
```json
{
  "name": "김민준",
  "parent_phone_1": "01012345678",
  "branch": "2단지",
  "status": "재원",
  "enrollments": [],
  "hacked_field": "malicious_data"
}
```
- expected: DENY

### 2.5 CREATE - FAIL: 필드 수 초과 (20개 초과)
- 21개 이상의 필드가 있는 문서 생성 시도
- expected: DENY

### 2.6 UPDATE - PASS: 유효한 업데이트
- 기존 문서의 status를 "실휴원"으로 변경 (merge: true 사용 시 전체 문서가 request.resource.data에 포함)
- expected: ALLOW

### 2.7 UPDATE - FAIL: 업데이트 후 필수 필드 누락
- name 필드가 빈 문자열("")인 업데이트
- expected: DENY

### 2.8 DELETE - PASS: 인증된 사용자의 삭제
- expected: ALLOW

---

## 3. Memos 서브컬렉션

### 3.1 CREATE - PASS: 유효한 메모
```json
{
  "text": "학부모 면담 내용 기록",
  "author": "teacher@gw.impact7.kr",
  "created_at": "<serverTimestamp>"
}
```
- expected: ALLOW

### 3.2 CREATE - FAIL: text 누락
```json
{
  "author": "teacher@gw.impact7.kr",
  "created_at": "<serverTimestamp>"
}
```
- expected: DENY

### 3.3 CREATE - FAIL: text가 빈 문자열
```json
{
  "text": "",
  "author": "teacher@gw.impact7.kr",
  "created_at": "<serverTimestamp>"
}
```
- expected: DENY

### 3.4 CREATE - FAIL: text 길이 초과 (2000자 초과)
- 2001자 이상의 text
- expected: DENY

### 3.5 CREATE - FAIL: 허용되지 않은 필드
```json
{
  "text": "메모 내용",
  "author": "teacher@gw.impact7.kr",
  "created_at": "<serverTimestamp>",
  "extra_field": "not_allowed"
}
```
- expected: DENY

### 3.6 UPDATE - FAIL: 메모 수정 차단
- 기존 메모의 text 필드 변경 시도
- expected: DENY (update: false)

### 3.7 DELETE - PASS: 인증된 사용자의 메모 삭제
- expected: ALLOW

---

## 4. History Logs 컬렉션

### 4.1 CREATE - PASS: 유효한 이력 로그
```json
{
  "doc_id": "김민준_01012345678_2단지",
  "change_type": "ENROLL",
  "before": "—",
  "after": "신규 등록: 김민준 (HA101)",
  "google_login_id": "teacher@gw.impact7.kr",
  "timestamp": "<serverTimestamp>"
}
```
- expected: ALLOW

### 4.2 CREATE - FAIL: change_type enum 위반
```json
{
  "doc_id": "김민준_01012345678_2단지",
  "change_type": "INVALID_TYPE",
  "before": "—",
  "after": "테스트",
  "google_login_id": "teacher@gw.impact7.kr",
  "timestamp": "<serverTimestamp>"
}
```
- expected: DENY

### 4.3 CREATE - FAIL: 필수 필드 누락 (doc_id 없음)
```json
{
  "change_type": "UPDATE",
  "before": "—",
  "after": "테스트",
  "google_login_id": "teacher@gw.impact7.kr",
  "timestamp": "<serverTimestamp>"
}
```
- expected: DENY

### 4.4 CREATE - FAIL: 허용되지 않은 필드
```json
{
  "doc_id": "test_doc",
  "change_type": "UPDATE",
  "before": "—",
  "after": "테스트",
  "google_login_id": "teacher@gw.impact7.kr",
  "timestamp": "<serverTimestamp>",
  "extra": "not_allowed"
}
```
- expected: DENY

### 4.5 UPDATE - FAIL: 이력 수정 차단
- 기존 이력 문서의 after 필드 변경 시도
- expected: DENY

### 4.6 DELETE - FAIL: 이력 삭제 차단
- expected: DENY

---

## 5. Catch-All 규칙

### 5.1 FAIL: 존재하지 않는 컬렉션 접근
- action: `get /unknown_collection/doc1`
- expected: DENY

### 5.2 FAIL: 루트 수준 문서 접근
- action: `get /random_doc`
- expected: DENY

---

## 6. GAS 호환성

### 6.1 GAS에서 students upsert
- GAS의 `upsertDocument_()` 함수가 보안 규칙의 필수 필드 검증을 통과하는지 확인
- GAS는 모든 필드를 포함하여 전체 문서를 전송하므로 PASS 예상

### 6.2 GAS에서 history_logs 생성
- GAS의 `createDocument_()` 함수가 timestamp를 ISO 문자열로 전송
- 규칙에서 timestamp 타입을 강제하지 않으므로 PASS 예상
- 주의: 향후 timestamp 타입 검증 추가 시 GAS 코드도 함께 수정 필요

### 6.3 GAS에서 change_type 값 확인
- GAS `importFromSheet()`에서 change_type: 'UPDATE' 사용 → PASS
- 만약 GAS에서 다른 change_type을 사용한다면 enum 목록에 추가 필요

---

## 배포 전 확인사항

1. [ ] Firebase Emulator에서 위 시나리오 전체 통과 확인
2. [ ] GAS 배포자 계정으로 students read/write 테스트
3. [ ] GAS 배포자 계정으로 history_logs create 테스트
4. [ ] 클라이언트(대시보드)에서 학생 등록/수정/삭제 테스트
5. [ ] 클라이언트에서 메모 추가/삭제 테스트
6. [ ] 클라이언트에서 이력 조회 테스트
7. [ ] 미인증 사용자 접근 차단 확인
