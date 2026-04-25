# Remove Enrollment from New Registration Form

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** impact7DB 신규 등록 폼에서 반 배정(enrollment) 필드를 제거하여, 신규 등록 시 status='상담' + enrollments=[]로만 저장되도록 한다. DSC 첫데이터입력과 동일한 역할.

**Architecture:** 신규 등록(`isEditMode=false`)일 때 `#enrollment-fields-container`를 숨기고, `submitNewStudent()` else 브랜치를 DSC의 `_upsertStudentFromTemp`처럼 동작하도록 단순화한다. 수정 모드(`isEditMode=true`)는 기존과 동일.

**Tech Stack:** Vanilla JS, HTML, Firestore Web SDK

---

### Task 1: showNewStudentForm() — enrollment 카드 숨김

**Files:**
- Modify: `app.js:1666-1716` (showNewStudentForm 함수)

신규 등록 폼을 열 때 `#enrollment-fields-container`를 숨기고, enrollment 관련 초기화 코드를 제거한다.

- [ ] **Step 1: enrollment 초기화 코드 제거 + 카드 숨김**

`app.js:1694-1715` 블록(수업종류 초기화 ~ 추가수업 버튼)을 아래로 교체:

```js
// enrollment 카드 숨김 (신규 등록은 반 배정 없음)
const enrollContainer = document.getElementById('enrollment-fields-container');
if (enrollContainer) enrollContainer.style.display = 'none';
```

제거 대상 코드:
```js
// 수업종류: 정규 기본 → 등원일 라벨 + 날짜 제한
const classTypeSelect = document.querySelector('[name="class_type"]');
if (classTypeSelect) classTypeSelect.value = '정규';
if (window.handleFormClassTypeChange) window.handleFormClassTypeChange();
applyDateConstraints(document.querySelector('[name="start_date"]'), document.querySelector('[name="special_end_date"]'));
if (window.handleStatusChange) window.handleStatusChange('재원');
// 학기 드롭다운 초기화
const _defaultSemester = activeFilters.semester || localStorage.getItem('lastSelectedSemester') || '';
const initSemSelect = document.getElementById('initial-semester-select');
if (initSemSelect) initSemSelect.innerHTML = getSemesterOptions('초등', _defaultSemester);
// 추가 수업 목록 초기화 + 버튼 표시
_pendingEnrollments = [];
renderPendingEnrollments();
const addEnrollBtn = document.getElementById('form-add-enrollment-btn');
if (addEnrollBtn) {
    addEnrollBtn.style.display = 'flex';
    addEnrollBtn.onclick = window.openFormEnrollmentModal;
}
```

- [ ] **Step 2: showEditForm()에서 enrollment 카드 복원**

`app.js:1775` (`if (staticFields) staticFields.style.display = 'none';` 직후)에 추가:

```js
// enrollment 카드 복원 (신규 등록에서 숨겼으므로 수정 모드에서 되살림)
const enrollContainer = document.getElementById('enrollment-fields-container');
if (enrollContainer) enrollContainer.style.display = '';
```

- [ ] **Step 3: 빌드 확인**
```bash
npm run build
```
Expected: 빌드 성공

---

### Task 2: submitNewStudent() — else 브랜치 단순화

**Files:**
- Modify: `app.js:1909-1961` (submitNewStudent else 브랜치)

`isEditMode=false`일 때의 분기를 DSC `_upsertStudentFromTemp`와 동일한 방식으로:
- **기존 학생 있음**: 기본 정보만 merge, status/enrollments 건드리지 않음
- **기존 학생 없음**: status='상담', enrollments=[]로 신규 생성

- [ ] **Step 1: else 브랜치 전체 교체**

`app.js:1909` (`} else {` 시작) ~ `app.js:1961` (`}` 끝, studentData 블록 포함) 을 아래로 교체:

```js
} else {
    // 신규 등록: 반 배정 없이 저장 (DSC 첫데이터입력과 동일)
    // 기본 정보만 (branch 제외 — 기존 학생은 보존, 신규 학생은 Step 2에서 추가)
    studentData = {
        name,
        level,
        school,
        grade,
        student_phone: f.student_phone.value.trim(),
        parent_phone_1: parentPhone1,
        parent_phone_2: f.parent_phone_2.value.trim(),
    };
}
```

- [ ] **Step 2: submitNewStudent() else 브랜치 내 Firestore 저장 로직 교체**

`app.js:2030` (`} else {` ~ `2059` `currentStudentId = docId;`) 를 아래로 교체:

```js
} else {
    const docId = makeDocId(name, parentPhone1);
    const existingStudent = allStudents.find(s => s.id === docId);

    if (existingStudent) {
        // 기존 학생 존재 (퇴원 등) — 기본 정보만 merge, status/enrollments 보존
        await setDoc(doc(db, 'students', docId), studentData, { merge: true });
        await addDoc(collection(db, 'history_logs'), {
            doc_id: docId,
            change_type: 'UPDATE',
            before: `상태: ${existingStudent.status || ''}`,
            after: `첫데이터 재입력: ${name}`,
            google_login_id: currentUser?.email || 'system',
            timestamp: serverTimestamp(),
        });
    } else {
        // 완전 신규 — '상담' 상태로 생성
        const newStudentData = {
            ...studentData,
            branch: '',       // 신규는 반 배정 전이므로 빈 값
            status: '상담',
            enrollments: [],
        };
        await setDoc(doc(db, 'students', docId), newStudentData);
        studentData = newStudentData; // 로컬 캐시용
        await addDoc(collection(db, 'history_logs'), {
            doc_id: docId,
            change_type: 'ENROLL',
            before: '—',
            after: `신규 등록 (첫데이터): ${name}`,
            google_login_id: currentUser?.email || 'system',
            timestamp: serverTimestamp(),
        });
    }
    currentStudentId = docId;
}
```

- [ ] **Step 3: 빌드 확인**
```bash
npm run build
```
Expected: 빌드 성공

---

### Task 3: 커밋

- [ ] **Step 1: 커밋**
```bash
cd /Users/jongsooyi/projects/impact7DB
git add app.js
git commit -m "feat: 신규 등록 폼에서 반 배정 제거 — 상담 상태로만 저장"
```

---

### 테스트 체크리스트

- [ ] 신규 등록 버튼 클릭 → 수업 정보 카드(상태, 반배정)가 보이지 않음
- [ ] 이름+전화 입력 후 저장 → students에 status='상담', enrollments=[] 로 저장됨
- [ ] 기존 학생(퇴원) 이름+전화로 신규 등록 → 기본 정보만 업데이트, status/enrollments 보존
- [ ] 기존 학생(재원) 클릭 → 수정 폼(showEditForm)에서 수업 정보 카드 정상 표시
- [ ] 기존 학생 수정 저장 → 기존과 동일하게 동작
