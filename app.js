import { onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, getDoc, doc, setDoc, addDoc, deleteDoc, deleteField, serverTimestamp, query, where, orderBy, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebase-config.js';
import { signInWithGoogle, logout, getGoogleAccessToken } from './auth.js';

// --- RFC 4180 compliant CSV line parser ---
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
            else if (ch === '"') { inQuotes = false; }
            else { current += ch; }
        } else {
            if (ch === '"') { inQuotes = true; }
            else if (ch === ',') { result.push(current.trim()); current = ''; }
            else { current += ch; }
        }
    }
    result.push(current.trim());
    return result;
}

// 학부별 학기 이름 목록
const SEMESTER_NAMES = {
    '초등': ['Winter', 'Spring', 'Summer', 'Autumn'],
    '중등': ['Winter', 'Spring', 'Summer', 'Autumn'],
    '고등': ['Winter', 'Spring', 'Autumn'],
};
const DEFAULT_SEMESTER_NAMES = ['Winter', 'Spring', 'Summer', 'Autumn'];

// 구글시트 내보내기/템플릿 공용 헤더
const STUDENT_SHEET_HEADERS = [
    'name', 'level', 'school', 'grade', 'student_phone',
    'parent_phone_1', 'parent_phone_2', 'guardian_name_1', 'guardian_name_2',
    'branch', 'level_symbol', 'class_number',
    'class_type', 'start_date', 'end_date', 'day',
    'status', 'pause_start_date', 'pause_end_date', 'semester', 'first_registered'
];

// semester를 제외한 필터가 하나라도 활성화되어 있는지 확인
const hasNonSemesterFilter = () =>
    Object.entries(activeFilters).filter(([k]) => k !== 'semester').some(([, v]) => v !== null);

// 학부 + 연도 기준으로 <option> 문자열 생성 (현재 연도 + 다음 연도)
function getSemesterOptions(level, selectedSemester) {
    const year = new Date().getFullYear();
    const names = SEMESTER_NAMES[level] || DEFAULT_SEMESTER_NAMES;
    return [year, year + 1].flatMap(y =>
        names.map(name => {
            const val = `${y}-${name}`;
            return `<option value="${val}"${val === selectedSemester ? ' selected' : ''}>${val}</option>`;
        })
    ).join('');
}

let currentUser = null;
let currentUserRole = null; // 'admin' | 'teacher' | null
let currentStudentId = null;
let allStudents = [];
// 타입별 독립 필터 — 다른 타입끼리 AND 복합 적용
let activeFilters = { level: null, branch: null, day: null, status: null, class_type: null, class_code: null, leave: null, semester: null, grade: null };
// 학기 필터는 localStorage에 저장하여 페이지 새로고침 후에도 유지
const _savedSemester = localStorage.getItem('semesterFilter');
if (_savedSemester) activeFilters.semester = _savedSemester;
let isEditMode = false;
let groupViewMode = 'none'; // 'none' | 'branch' | 'class'
let _pendingEnrollments = []; // 신규등록 시 추가 수업 목록
let _editEnrollments = []; // 수정 중인 enrollment 배열
let bulkMode = false;
let selectedStudentIds = new Set();
let siblingMap = {};    // studentId → [siblingId, ...]
let memoCache = {};     // studentId → true/false (메모 존재 여부)
let semesterSettings = {};   // semester → { start_date }
let currentSemester = null;  // 오늘 기준 현재 학기
let currentFilteredStudents = null; // 필터 적용 후 학생 목록 (내보내기용)
let allContacts = []; // contacts 컬렉션 캐시

// HTML 이스케이프 — 사용자 입력을 innerHTML에 삽입할 때 XSS 방지
const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
};

// enrollment 코드 = level_symbol + class_number (예: HA + 101 = HA101)
const enrollmentCode = (e) => `${e.level_symbol || ''}${e.class_number || ''}`;

// 모든 enrollment의 코드 목록
const allClassCodes = (s) => (s.enrollments || []).map(e => enrollmentCode(e)).filter(Boolean);

// class_number 첫 번째 숫자로 단지 자동 파생: '1xx' → '2단지', '2xx' → '10단지'
const branchFromClassNumber = (num) => {
    const first = (num || '').trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
};

// 학생의 소속: branch 필드 우선, 없으면 첫 번째 enrollment의 class_number에서 파생
const branchFromStudent = (s) => s.branch || (s.enrollments?.[0] ? branchFromClassNumber(s.enrollments[0].class_number) : '');

// 학생의 모든 소속 지점 (여러 enrollment에서 파생된 지점 합집합)
const branchesFromStudent = (s) => {
    const set = new Set();
    (s.enrollments || []).forEach(e => {
        const b = branchFromClassNumber(e.class_number);
        if (b) set.add(b);
    });
    if (set.size === 0 && s.branch) set.add(s.branch);
    return [...set];
};

/**
 * 활성 enrollment만 반환.
 * 같은 class_type 내에서 start_date <= 오늘인 것 중 가장 최근 것만 활성.
 * start_date > 오늘이면 "예정" (비활성).
 * 같은 class_type의 새 enrollment이 없으면 이전 것이 계속 활성.
 * 내신이 활성 기간이면 정규를 숨김.
 */
const getActiveEnrollments = (s) => {
    const enrollments = s.enrollments || [];
    if (enrollments.length === 0) return [];

    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const byType = {};

    for (const e of enrollments) {
        const key = (e.class_type || '정규') + ':' + (e.class_number || '');
        if (!byType[key]) byType[key] = [];
        byType[key].push(e);
    }

    const active = [];
    const validDate = (d) => d && /^\d{4}-/.test(d);

    for (const [ct, list] of Object.entries(byType)) {
        // start_date <= 오늘인 것 중 가장 최근
        const started = list
            .filter(e => !validDate(e.start_date) || e.start_date <= today)
            .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));

        if (started.length > 0) {
            active.push(started[0]);
        } else {
            // 모두 미래이면 → 가장 이른 것 (예정)
            const sorted = [...list].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
            active.push(sorted[0]);
        }
    }

    // end_date가 지난 enrollment(내신/특강) 제외
    const current = active.filter(e => {
        if (!validDate(e.end_date)) return true;
        return e.end_date >= today;
    });

    // 내신이 활성 기간이면 정규를 숨김 (내신 종료 후 정규 복귀)
    const hasActiveNaesin = current.some(e =>
        e.class_type === '내신' &&
        validDate(e.start_date) && e.start_date <= today
    );
    if (hasActiveNaesin) {
        return current.filter(e => e.class_type !== '정규');
    }
    return current;
};

// 활성 enrollment의 요일 합집합 (내신 기간 중에는 정규 제외됨)
const combinedDays = (s) => [...new Set(getActiveEnrollments(s).flatMap(e => normalizeDays(e.day)))];

// 현재 맥락에 맞는 enrollment 반환: 학기 필터 있으면 해당 학기, 없으면 활성
const relevantEnrollments = (s) => activeFilters.semester
    ? (s.enrollments || []).filter(e => e.semester === activeFilters.semester)
    : getActiveEnrollments(s);

const activeClassCodes = (s) => relevantEnrollments(s).map(e => enrollmentCode(e)).filter(Boolean);

const activeBranchesFromStudent = (s) => {
    const set = new Set();
    relevantEnrollments(s).forEach(e => {
        const b = branchFromClassNumber(e.class_number);
        if (b) set.add(b);
    });
    if (set.size === 0 && s.branch) set.add(s.branch);
    return [...set];
};

const activeDays = (s) => [...new Set(relevantEnrollments(s).flatMap(e => normalizeDays(e.day)))];

// 학교명 축약 표시 (예: 진명여자고등학교 고등 2학년 → 진명여고2)
const abbreviateSchool = (s) => {
    // 더 긴 접미사를 먼저 체크해야 부분 일치 오류를 제거할 수 있음
    const school = (s.school || '')
        .replace(/고등학교$/, '')
        .replace(/중학교$/, '')
        .replace(/초등학교$/, '')
        .replace(/학교$/, '')
        .trim();
    const level = (s.level || '');
    const levelShort = level === '초등' ? '초' : level === '중등' ? '중' : level === '고등' ? '고' : level;
    const grade = s.grade ? `${s.grade}` : '';
    return `${school}${levelShort}${grade}`.trim() || '—';
};

// ---------------------------------------------------------------------------
// 한글 초성 검색 헬퍼
// ---------------------------------------------------------------------------
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

// 완성형 한글에서 초성 추출 (가=0xAC00, 각 초성 = 21*28 = 588 간격)
const getChosung = (str) => {
    return [...(str || '')].map(ch => {
        const code = ch.charCodeAt(0);
        if (code >= 0xAC00 && code <= 0xD7A3) return CHO[Math.floor((code - 0xAC00) / 588)];
        return ch;
    }).join('');
};

// 검색어가 초성으로만 구성되어 있는지 확인
const isChosungOnly = (str) => str && [...str].every(ch => CHO.includes(ch));

// 초성 패턴 매칭: 검색어 초성이 대상 문자열의 초성에 포함되는지
const matchChosung = (target, term) => {
    if (!target || !term) return false;
    return getChosung(target).includes(term);
};

// day 필드 정규화 → 배열 (예: "월요일" → ["월"], ["월","수"] → ["월","수"])
const normalizeDays = (day) => {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
};

// day 배열 → 표시용 문자열 (예: ["월","수"] → "월, 수")
const displayDays = (day) => {
    const days = normalizeDays(day);
    return days.length ? days.join(', ') : 'N/A';
};

// class_type 정규화 → 배열 (예: "정규" → ["정규"], ["정규","특강"] → ["정규","특강"])
const normalizeClassTypes = (ct) => {
    if (!ct) return ['정규'];
    if (Array.isArray(ct)) return ct;
    return ct.split(/[,·\s]+/).map(s => s.trim()).filter(Boolean);
};

// 기존 flat 필드 → enrollments 배열 자동 변환 (마이그레이션)
const normalizeEnrollments = (s) => {
    if (s.enrollments?.length) return s.enrollments;
    // 레거시 flat 필드 매핑: level_symbol (또는 level_code 폴백) → levelSymbol, class_number → classNumber
    // GAS Code.gs의 migrateToEnrollments와 동일한 매핑 (기존 코드는 필드가 뒤바뀌어 있었음)
    const levelSymbol = s.level_symbol || s.level_code || '';
    const classNumber = s.class_number || '';
    const classTypes = normalizeClassTypes(s.class_type);
    const day = normalizeDays(s.day);
    if (classTypes.length <= 1) {
        const ct = classTypes[0] || '정규';
        const e = { class_type: ct, level_symbol: levelSymbol, class_number: classNumber, day, start_date: ct === '특강' ? (s.special_start_date || s.start_date || '') : (s.start_date || '') };
        if (ct === '특강') e.end_date = s.special_end_date || '';
        return [e];
    }
    return classTypes.map(ct => {
        const e = { class_type: ct, level_symbol: levelSymbol, class_number: classNumber, day, start_date: ct === '특강' ? (s.special_start_date || '') : (s.start_date || '') };
        if (ct === '특강') e.end_date = s.special_end_date || '';
        return e;
    });
};

// 폼 카드 타이틀 변경 헬퍼
const setFormCardTitle = (el, text) => {
    if (!el) return;
    // 아이콘 span 유지하고 텍스트만 교체
    const iconSpan = el.querySelector('.material-symbols-outlined');
    const btnHtml = el.querySelector('.memo-add-btn')?.outerHTML || '';
    el.innerHTML = '';
    if (iconSpan) el.appendChild(iconSpan);
    el.appendChild(document.createTextNode(' ' + text + ' '));
    if (btnHtml) el.insertAdjacentHTML('beforeend', btnHtml);
};
const setFormCardTitles = (basic, contact, classInfo) => {
    setFormCardTitle(document.getElementById('form-card-title-basic'), basic);
    setFormCardTitle(document.getElementById('form-card-title-contact'), contact);
    setFormCardTitle(document.getElementById('form-card-title-class'), classInfo);
};

const formatDate = (dateStr) => {
    if (!dateStr || dateStr === '?') return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------
// 사용자 역할 로드
async function loadUserRole(email) {
    try {
        const userDoc = await getDoc(doc(db, 'users', email));
        if (userDoc.exists()) {
            currentUserRole = userDoc.data().role || 'teacher';
        } else {
            currentUserRole = 'teacher';
        }
    } catch (e) {
        console.warn('[ROLE] Failed to load user role:', e.code, e.message);
        currentUserRole = 'teacher';
    }
    applyRoleUI();
}

// 역할에 따른 UI 표시/숨김
function applyRoleUI() {
    const statsNav = document.querySelector('.stats-nav-item');
    if (statsNav) {
        statsNav.style.display = currentUserRole === 'admin' ? '' : 'none';
    }
}

onAuthStateChanged(auth, async (user) => {
    const avatarBtn = document.querySelector('.avatar');

    if (user) {
        // 도메인 체크: gw.impact7.kr 또는 impact7.kr 인증된 계정만 허용
        const email = user.email || '';
        const allowedDomain = email.endsWith('@gw.impact7.kr') || email.endsWith('@impact7.kr');
        if (!user.emailVerified || !allowedDomain) {
            alert('❌ 허용되지 않은 계정입니다.\n학원 계정(@gw.impact7.kr 또는 @impact7.kr)으로 다시 로그인해주세요.');
            await logout();
            return;
        }

        currentUser = user;
        avatarBtn.textContent = user.email[0].toUpperCase();
        avatarBtn.title = `Logged in as ${user.email} (click to logout)`;
        await loadUserRole(email);
        await loadSemesterSettings();
        getCurrentSemester();
        loadStudentList();
        loadContacts();
    } else {
        currentUser = null;
        currentUserRole = null;
        applyRoleUI();
        avatarBtn.textContent = 'G';
        avatarBtn.title = 'Login with Google';
        document.querySelector('.list-items').innerHTML =
            '<p style="padding:16px;color:var(--text-sec)">Please log in to view students.</p>';
        updateCount(null);
    }
});

// ---------------------------------------------------------------------------
// Login / Logout
// ---------------------------------------------------------------------------
window.handleLogin = async () => {
    try {
        if (currentUser) await logout();
        else await signInWithGoogle();
    } catch (error) {
        const messages = {
            'auth/api-key-not-valid': '❌ API 키 오류 — Firebase Console에서 API 키를 확인하세요',
            'auth/unauthorized-domain': '❌ 인증되지 않은 도메인 — Firebase Auth > 승인된 도메인에 localhost를 추가하세요',
            'auth/popup-blocked': '❌ 팝업이 차단됨 — 브라우저에서 팝업을 허용해주세요',
            'auth/popup-closed-by-user': '팝업이 닫혔습니다. 다시 시도하세요.',
            'auth/cancelled-popup-request': '이미 로그인 팝업이 열려 있습니다.',
        };
        const msg = messages[error.code] || `❌ 로그인 실패: ${error.code}`;
        console.error('[AUTH ERROR]', error.code, error.message);
        alert(msg);
    }
};

// ---------------------------------------------------------------------------
// Load all students from Firestore, sort by name (Korean-aware)
// ---------------------------------------------------------------------------
async function loadStudentList() {
    const listContainer = document.querySelector('.list-items');
    listContainer.innerHTML = '<p style="padding:16px;color:var(--text-sec)">Loading...</p>';

    try {
        const snapshot = await getDocs(collection(db, 'students'));
        allStudents = [];
        snapshot.forEach((docSnap) => {
            const data = { id: docSnap.id, ...docSnap.data() };
            data.enrollments = normalizeEnrollments(data);
            allStudents.push(data);
        });
        allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
        buildSiblingMap();
        buildClassFilterSidebar();
        buildGradeFilterSidebar();
        buildSemesterFilter();
        updateReadonlyBanner();
        updateLeaveCountBadges();
        loadMemoCacheAndRender();
        generateDailyStatsIfNeeded();
    } catch (error) {
        console.error('[FIRESTORE ERROR] Failed to load students:', error);
        listContainer.innerHTML = '<p style="padding:16px;color:red">Failed to load students.</p>';
    }
}

window.refreshStudents = loadStudentList;

// ---------------------------------------------------------------------------
// contacts 컬렉션 로딩
// ---------------------------------------------------------------------------
async function loadContacts() {
    try {
        const snapshot = await getDocs(collection(db, 'contacts'));
        allContacts = [];
        snapshot.forEach((docSnap) => {
            allContacts.push({ id: docSnap.id, ...docSnap.data() });
        });

        // allStudents → contacts DB 동기화 (contacts에 없는 학생은 DB에 저장)
        const contactIdSet = new Set(allContacts.map(c => c.id));
        const toSync = [];
        for (const s of allStudents) {
            if (!contactIdSet.has(s.id)) {
                const contactData = {
                    name: s.name || '',
                    school: s.school || '',
                    grade: s.grade || '',
                    student_phone: s.student_phone || '',
                    parent_phone_1: s.parent_phone_1 || '',
                    parent_phone_2: s.parent_phone_2 || '',
                    guardian_name_1: s.guardian_name_1 || '',
                    guardian_name_2: s.guardian_name_2 || '',
                    level: s.level || '',
                    updated_at: serverTimestamp(),
                };
                toSync.push({ id: s.id, data: contactData });
                allContacts.push({ id: s.id, ...contactData });
                contactIdSet.add(s.id);
            }
        }
        if (toSync.length > 0) {
            console.log(`[loadContacts] 새 학생 ${toSync.length}명 → contacts DB 동기화`);
            (async () => {
                try {
                    for (let i = 0; i < toSync.length; i += 500) {
                        const batch = writeBatch(db);
                        toSync.slice(i, i + 500).forEach(item => {
                            batch.set(doc(db, 'contacts', item.id), item.data);
                        });
                        await batch.commit();
                    }
                    console.log(`[loadContacts] contacts DB 동기화 완료 (${toSync.length}건)`);
                } catch (e) {
                    console.warn('[loadContacts] contacts DB 동기화 실패:', e);
                }
            })();
        }
        console.log(`[loadContacts] contacts=${snapshot.size}, 동기화 후 allContacts=${allContacts.length}`);
        allContacts.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
    } catch (error) {
        console.error('[FIRESTORE ERROR] Failed to load contacts:', error);
    }
}

// ---------------------------------------------------------------------------
// 일별 통계 스냅샷 (Daily Stats)
// ---------------------------------------------------------------------------
const getTodayDateStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function generateDailyStatsIfNeeded() {
    const dateStr = getTodayDateStr();
    const statsRef = doc(db, 'daily_stats', dateStr);
    try {
        const existing = await getDoc(statsRef);
        if (existing.exists()) return; // 이미 생성됨

        // 통계 집계
        const byStatus = {};
        const byBranch = {};
        const byLevel = {};
        const byClassCode = {};
        const byStatusBranch = {}; // { '2단지': { 재원: N, ... }, '10단지': { ... } }
        const byLevelSymbolBranch = {}; // { 'HA': { level: '고등', '2단지': N, '10단지': N }, ... }
        let total = 0;
        let activeTotal = 0; // 퇴원 제외

        allStudents.forEach(s => {
            total++;
            const st = s.status || '재원';
            byStatus[st] = (byStatus[st] || 0) + 1;
            if (st !== '퇴원') activeTotal++;

            const branches = branchesFromStudent(s);
            branches.forEach(br => {
                byBranch[br] = (byBranch[br] || 0) + 1;
                if (!byStatusBranch[br]) byStatusBranch[br] = {};
                byStatusBranch[br][st] = (byStatusBranch[br][st] || 0) + 1;
            });

            const lv = s.level || '';
            if (lv) byLevel[lv] = (byLevel[lv] || 0) + 1;

            (s.enrollments || []).forEach(e => {
                const code = enrollmentCode(e);
                if (code) byClassCode[code] = (byClassCode[code] || 0) + 1;
                const ls = e.level_symbol || '';
                const eBranch = branchFromClassNumber(e.class_number);
                if (ls) {
                    if (!byLevelSymbolBranch[ls]) byLevelSymbolBranch[ls] = { level: lv };
                    if (eBranch) byLevelSymbolBranch[ls][eBranch] = (byLevelSymbolBranch[ls][eBranch] || 0) + 1;
                }
            });
        });

        await setDoc(statsRef, {
            date: dateStr,
            generated_at: serverTimestamp(),
            generated_by: currentUser?.email || 'unknown',
            total,
            active_total: activeTotal,
            by_status: byStatus,
            by_branch: byBranch,
            by_level: byLevel,
            by_class_code: byClassCode,
            by_status_branch: byStatusBranch,
            by_level_symbol_branch: byLevelSymbolBranch
        });
        // snapshot generated
    } catch (e) {
        console.warn('[DAILY STATS] Failed to generate:', e);
    }
}

// ---------------------------------------------------------------------------
// 형제(Sibling) 맵 빌드 — 부모 연락처가 같으면 형제
// ---------------------------------------------------------------------------
function buildSiblingMap() {
    siblingMap = {};
    const idToStudent = new Map(allStudents.map(s => [s.id, s]));
    const phoneToIds = {};
    allStudents.forEach(s => {
        const phones = [...new Set([s.parent_phone_1, s.parent_phone_2]
            .map(p => (p || '').replace(/\D/g, '')).filter(p => p.length >= 9))];
        phones.forEach(p => {
            if (!phoneToIds[p]) phoneToIds[p] = [];
            phoneToIds[p].push(s.id);
        });
    });
    // 같은 전화번호를 공유하는 학생끼리 형제
    Object.values(phoneToIds).forEach(ids => {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length < 2) return;
        uniqueIds.forEach(id => {
            const student = idToStudent.get(id);
            if (!student) return;
            // 같은 이름 = 본인(중복 문서)이므로 형제에서 제외
            const siblings = uniqueIds.filter(sid => {
                if (sid === id) return false;
                const other = idToStudent.get(sid);
                return other && other.name !== student.name;
            });
            if (siblings.length > 0) {
                if (!siblingMap[id]) siblingMap[id] = new Set();
                siblings.forEach(sid => siblingMap[id].add(sid));
            }
        });
    });
}

// ---------------------------------------------------------------------------
// 메모 존재 여부 캐시 — 비동기로 한 번만 로드
// ---------------------------------------------------------------------------
async function loadMemoCacheAndRender() {
    memoCache = {};
    // allStudents의 has_memo 필드로 캐시 구성 (추가 쿼리 0건)
    allStudents.forEach(s => { if (s.has_memo) memoCache[s.id] = true; });
    applyFilterAndRender();
}

// 개별 리스트 아이템의 아이콘만 업데이트 (전체 리렌더 없이)
function updateListItemIcons(studentId) {
    const el = document.querySelector(`.list-item[data-id="${CSS.escape(studentId)}"]`);
    if (!el) return;
    const titleSpan = el.querySelector('.item-title');
    if (!titleSpan) return;
    // 기존 아이콘 제거
    titleSpan.querySelectorAll('.item-icon').forEach(ic => ic.remove());
    // 상태 뱃지 앞에 다시 삽입
    const statusEl = titleSpan.querySelector('.item-status');
    const s = allStudents.find(s => s.id === studentId);
    if (!s) return;
    const hasSibling = siblingMap[s.id] && siblingMap[s.id].size > 0;
    const hasMemo = memoCache[s.id];
    const siblingNames = hasSibling ? [...siblingMap[s.id]].map(sid => allStudents.find(x => x.id === sid)?.name).filter(Boolean).join(', ') : '';
    if (hasMemo) {
        const m = document.createElement('span');
        m.className = 'item-icon item-icon-memo';
        m.title = '메모 있음';
        m.innerHTML = '<span class="material-symbols-outlined">sticky_note_2</span>';
        statusEl ? titleSpan.insertBefore(m, statusEl) : titleSpan.appendChild(m);
    }
    if (hasSibling) {
        const si = document.createElement('span');
        si.className = 'item-icon item-icon-sibling';
        si.title = `형제: ${siblingNames}`;
        si.innerHTML = '<span class="material-symbols-outlined">group</span>';
        statusEl ? titleSpan.insertBefore(si, statusEl) : titleSpan.appendChild(si);
    }
}

// ---------------------------------------------------------------------------
// On Leave 카운트 업데이트
// ---------------------------------------------------------------------------
function updateLeaveCountBadges() {
    const today = new Date(); today.setHours(0,0,0,0);
    const in10 = new Date(today); in10.setDate(in10.getDate() + 10);

    const onLeave = allStudents.filter(s => s.status === '실휴원' || s.status === '가휴원');
    const expected = onLeave.filter(s => {
        const end = s.pause_end_date ? new Date(s.pause_end_date) : null;
        if (!end) return false; end.setHours(0,0,0,0);
        return end >= today && end <= in10;
    });
    const nonReturn = onLeave.filter(s => {
        const end = s.pause_end_date ? new Date(s.pause_end_date) : null;
        if (!end) return false; end.setHours(0,0,0,0);
        return end < today;
    });

    const el1 = document.getElementById('on-leave-count');
    const el2 = document.getElementById('on-leave-expected-count');
    const el3 = document.getElementById('on-leave-nonreturn-count');
    if (el1) el1.textContent = onLeave.length || '';
    if (el2) el2.textContent = expected.length || '';
    if (el3) el3.textContent = nonReturn.length || '';
}

// 동적 필터 사이드바 공용 빌더
function buildDynamicFilterSidebar({ listId, filterKey, emptyMsg, getItems, sortFn, labelFn, preFilter }) {
    const list = document.getElementById(listId);
    if (!list) return;

    const targetStudents = preFilter ? allStudents.filter(preFilter) : allStudents;
    const countMap = {};
    targetStudents.forEach(s => {
        getItems(s).forEach(item => {
            if (item) countMap[item] = (countMap[item] || 0) + 1;
        });
    });

    const sorted = Object.keys(countMap).sort(sortFn);

    if (sorted.length === 0) {
        list.innerHTML = `<li style="padding:8px 12px 8px 28px;font-size:12px;color:var(--text-sec);">${emptyMsg}</li>`;
        return;
    }

    list.innerHTML = '';
    sorted.forEach(value => {
        const li = document.createElement('li');
        li.className = 'menu-l2 nav-item' + (activeFilters[filterKey] === value ? ' active' : '');
        li.dataset.filterType = filterKey;
        li.dataset.filterValue = value;
        li.innerHTML = `<span class="class-filter-item"><span class="class-filter-code">${labelFn(value)}</span></span><span class="class-filter-count">${countMap[value]}</span>`;
        li.addEventListener('click', () => {
            if (activeFilters[filterKey] === value) {
                activeFilters[filterKey] = null;
                li.classList.remove('active');
            } else {
                list.querySelectorAll('.nav-item.active').forEach(el => el.classList.remove('active'));
                activeFilters[filterKey] = value;
                li.classList.add('active');
            }
            document.querySelector('.menu-l1[data-filter-type="all"]')?.classList.remove('active');
            applyFilterAndRender();
        });
        list.appendChild(li);
    });
}

function buildClassFilterSidebar() {
    const semFilter = activeFilters.semester;
    buildDynamicFilterSidebar({
        listId: 'class-filter-list',
        filterKey: 'class_code',
        emptyMsg: '등록된 반이 없습니다',
        preFilter: activeFilters.branch ? s => branchesFromStudent(s).includes(activeFilters.branch) : null,
        getItems: s => {
            const enrollments = semFilter
                ? (s.enrollments || []).filter(e => e.semester === semFilter)
                : getActiveEnrollments(s);
            return enrollments.map(e => enrollmentCode(e)).filter(Boolean);
        },
        sortFn: (a, b) => a.localeCompare(b, 'ko'),
        labelFn: code => esc(code),
    });
}

const GRADE_ORDER = ['초4','초5','초6','중1','중2','중3','고1','고2','고3','기타'];
const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고' };

function studentGradeKey(s) {
    const prefix = LEVEL_SHORT[s.level];
    const g = Number(s.grade);
    if (prefix && g) {
        const key = prefix + g;
        if (GRADE_ORDER.includes(key)) return key;
    }
    return '기타';
}

function buildGradeFilterSidebar() {
    const semFilter = activeFilters.semester;
    buildDynamicFilterSidebar({
        listId: 'grade-filter-list',
        filterKey: 'grade',
        emptyMsg: '학년 정보가 없습니다',
        preFilter: s => {
            if (semFilter) return s.enrollments ? s.enrollments.some(e => e.semester === semFilter) : false;
            return true;
        },
        getItems: s => [studentGradeKey(s)],
        sortFn: (a, b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b),
        labelFn: key => esc(key),
    });
}

// ---------------------------------------------------------------------------
// Filter + search then render
// ---------------------------------------------------------------------------
function applyFilterAndRender() {
    // 필터 변경 시 동적 사이드바 갱신
    buildClassFilterSidebar();
    buildGradeFilterSidebar();
    if (activeFilters.grade) {
        const gradeListEl = document.getElementById('grade-filter-list');
        const stillExists = gradeListEl?.querySelector(`[data-filter-value="${CSS.escape(activeFilters.grade)}"]`);
        if (!stillExists) activeFilters.grade = null;
    }
    if (activeFilters.class_code) {
        const classListEl = document.getElementById('class-filter-list');
        const stillExists = classListEl?.querySelector(`[data-filter-value="${CSS.escape(activeFilters.class_code)}"]`);
        if (!stillExists) activeFilters.class_code = null;
    }

    let filtered = allStudents;

    // 필터가 아무것도 활성화되지 않은 상태(All Students 기본) → 퇴원 제외
    if (!hasNonSemesterFilter()) {
        filtered = filtered.filter(s => s.status !== '퇴원');
    }

    // 각 타입별로 AND 조건 적용
    if (activeFilters.level) filtered = filtered.filter(s => s.level === activeFilters.level);
    if (activeFilters.branch) filtered = filtered.filter(s => activeBranchesFromStudent(s).includes(activeFilters.branch));
    if (activeFilters.day) filtered = filtered.filter(s => activeDays(s).includes(activeFilters.day));
    if (activeFilters.status) filtered = filtered.filter(s => s.status === activeFilters.status);
    if (activeFilters.class_type) filtered = filtered.filter(s => relevantEnrollments(s).some(e => e.class_type === activeFilters.class_type));
    if (activeFilters.class_code) filtered = filtered.filter(s => activeClassCodes(s).includes(activeFilters.class_code));
    if (activeFilters.grade) filtered = filtered.filter(s => studentGradeKey(s) === activeFilters.grade);
    // 휴원 필터 활성 시에는 학기 필터를 건너뜀 (휴원생은 현재 학기 enrollment이 없을 수 있음)
    if (activeFilters.semester && !activeFilters.leave) filtered = filtered.filter(s => (s.enrollments || []).some(e => e.semester === activeFilters.semester));
    if (activeFilters.leave) {
        const lv = activeFilters.leave;
        const today = new Date(); today.setHours(0,0,0,0);
        const in10 = new Date(today); in10.setDate(in10.getDate() + 10);
        const isOnLeave = (s) => s.status === '실휴원' || s.status === '가휴원';
        const endDate = (s) => { const d = s.pause_end_date ? new Date(s.pause_end_date) : null; if (d) d.setHours(0,0,0,0); return d; };
        const isExpected = (s) => { const e = endDate(s); return e && e >= today && e <= in10; };
        const isNonReturn = (s) => { const e = endDate(s); return e && e < today; };

        if (lv === 'all') {
            filtered = filtered.filter(isOnLeave);
        } else if (lv === 'expected') {
            filtered = filtered.filter(s => isOnLeave(s) && isExpected(s));
        } else if (lv === 'expected_actual') {
            filtered = filtered.filter(s => s.status === '실휴원' && isExpected(s));
        } else if (lv === 'expected_pending') {
            filtered = filtered.filter(s => s.status === '가휴원' && isExpected(s));
        } else if (lv === 'non_return') {
            filtered = filtered.filter(s => isOnLeave(s) && isNonReturn(s));
        } else if (lv === 'nonreturn_actual') {
            filtered = filtered.filter(s => s.status === '실휴원' && isNonReturn(s));
        } else if (lv === 'nonreturn_pending') {
            filtered = filtered.filter(s => s.status === '가휴원' && isNonReturn(s));
        }
    }

    const term = document.getElementById('studentSearchInput')?.value.trim().toLowerCase() || '';
    let contactResults = [];
    if (term) {
        const chosungMode = isChosungOnly(term);
        filtered = filtered.filter(s => {
            if (chosungMode) {
                // 초성 검색: 이름, 학교에서 초성 매칭
                return matchChosung(s.name, term) ||
                    matchChosung(s.school, term);
            }
            // 일반 검색
            return (s.name && s.name.toLowerCase().includes(term)) ||
                (s.school && s.school.toLowerCase().includes(term)) ||
                (s.student_phone && s.student_phone.includes(term)) ||
                (s.parent_phone_1 && s.parent_phone_1.includes(term)) ||
                allClassCodes(s).some(code => code.toLowerCase().includes(term));
        });

        // contacts에서 과거 학생 검색 (현재 필터 결과에 없는 학생만)
        const filteredIdSet = new Set(filtered.map(s => s.id));
        contactResults = allContacts.filter(c => {
            if (filteredIdSet.has(c.id)) return false;
            if (chosungMode) {
                return matchChosung(c.name, term) || matchChosung(c.school, term);
            }
            return (c.name && c.name.toLowerCase().includes(term)) ||
                (c.school && c.school.toLowerCase().includes(term)) ||
                (c.student_phone && c.student_phone.includes(term)) ||
                (c.parent_phone_1 && c.parent_phone_1.includes(term));
        });
    }

    currentFilteredStudents = filtered;
    updateFilterChips();
    renderStudentList(filtered, contactResults);
}

// 활성 필터 요약을 카운트 칩 옆에 표시
function updateFilterChips() {
    const active = Object.entries(activeFilters).filter(([, v]) => v !== null);
    const nonSemester = active.filter(([k]) => k !== 'semester');
    const chipsEl = document.getElementById('filter-chips');
    const clearBtn = document.getElementById('filter-clear-btn');
    if (!chipsEl) return;
    if (nonSemester.length === 0) {
        chipsEl.textContent = '';
        if (clearBtn) clearBtn.style.display = 'none';
        return;
    }
    chipsEl.textContent = nonSemester.map(([, v]) => v).join(' · ');
    if (clearBtn) clearBtn.style.display = 'flex';
}

window.clearFilters = () => {
    // semester는 sticky — 명시적으로 드롭다운에서 바꾸기 전까지 유지
    const keepSemester = activeFilters.semester;
    Object.keys(activeFilters).forEach(k => activeFilters[k] = null);
    activeFilters.semester = keepSemester;
    // 학기 드롭다운 UI 동기화
    syncSemesterDropdowns(keepSemester || '');
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector('.menu-l1[data-filter-type="all"]')?.classList.add('active');
    // 동적 필터 active 해제
    document.querySelectorAll('#class-filter-list .nav-item, #grade-filter-list .nav-item').forEach(el => el.classList.remove('active'));
    applyFilterAndRender();
};

// 사이드바 + 모바일 학기 드롭다운 동기화
function syncSemesterDropdowns(val) {
    const ids = ['semester-filter', 'semester-filter-mobile'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = val; });
}

window.handleSemesterFilter = (val) => {
    activeFilters.semester = val || null;
    // localStorage에 저장 — 페이지 새로고침 후에도 유지
    if (val) {
        localStorage.setItem('semesterFilter', val);
        localStorage.setItem('lastSelectedSemester', val);
    } else {
        localStorage.removeItem('semesterFilter');
    }
    syncSemesterDropdowns(val || '');
    updateReadonlyBanner();
    applyFilterAndRender();
};

// ─── 학기 설정 (시작일) ──────────────────────────────────────────────────
async function loadSemesterSettings() {
    const snap = await getDocs(collection(db, 'semester_settings'));
    semesterSettings = {};
    snap.forEach(d => { semesterSettings[d.id] = d.data(); });
}

function getCurrentSemester() {
    const today = new Date().toISOString().slice(0, 10);
    const entries = Object.entries(semesterSettings)
        .filter(([, v]) => v.start_date)
        .sort((a, b) => a[1].start_date.localeCompare(b[1].start_date));
    let result = null;
    for (const [semester, { start_date }] of entries) {
        if (start_date <= today) result = semester;
    }
    currentSemester = result;
    return result;
}

function isPastSemester() {
    if (!currentSemester) return false;
    if (activeFilters.semester && activeFilters.semester !== currentSemester) return true;
    return false;
}

function updateReadonlyBanner() {
    const banner = document.getElementById('semester-readonly-banner');
    if (banner) banner.style.display = isPastSemester() ? '' : 'none';
}

// ─── 학기 시작일 설정 모달 ──────────────────────────────────────────────────
window.openSemesterSettingsModal = () => {
    const modal = document.getElementById('semester-settings-modal');
    const body = document.getElementById('semester-settings-body');
    if (!modal || !body) return;

    const semesters = new Set();
    allStudents.forEach(s =>
        (s.enrollments || []).forEach(e => { if (e.semester) semesters.add(e.semester); })
    );
    semesters.delete('2026-Spring1');
    semesters.delete('2026-Spring2');
    semesters.delete('2027-Spring1');
    semesters.delete('2027-Spring2');
    const sorted = [...semesters].sort();

    if (sorted.length === 0) {
        body.innerHTML = '<p style="color:var(--text-sec);font-size:13px;">등록된 학기가 없습니다.</p>';
    } else {
        body.innerHTML = sorted.map(sem => {
            const setting = semesterSettings[sem] || {};
            const isCurrent = sem === currentSemester;
            return `<div class="semester-setting-row">
                <span class="semester-setting-label">${esc(sem)}${isCurrent ? '<span class="current-badge">현재</span>' : ''}</span>
                <input type="date" class="semester-setting-date" value="${setting.start_date || ''}"
                    onchange="window.saveSemesterStartDate('${esc(sem)}', this.value)">
            </div>`;
        }).join('');
    }
    modal.style.display = 'flex';
};

window.closeSemesterSettingsModal = (e) => {
    if (e && e.target !== document.getElementById('semester-settings-modal')) return;
    document.getElementById('semester-settings-modal').style.display = 'none';
};

window.saveSemesterStartDate = async (semester, startDate) => {
    try {
        if (startDate) {
            await setDoc(doc(db, 'semester_settings', semester), { start_date: startDate });
            semesterSettings[semester] = { start_date: startDate };
        } else {
            await deleteDoc(doc(db, 'semester_settings', semester));
            delete semesterSettings[semester];
        }
        getCurrentSemester();
        updateReadonlyBanner();
        window.openSemesterSettingsModal();
    } catch (err) {
        console.error('학기 시작일 저장 실패:', err);
        alert('저장 실패: ' + err.message);
    }
};

function buildSemesterFilter() {
    const semesters = new Set();
    allStudents.forEach(s => (s.enrollments || []).forEach(e => { if (e.semester) semesters.add(e.semester); }));
    // Spring1/Spring2는 Spring으로 통합되었으므로 필터에서 제외
    semesters.delete('2026-Spring1');
    semesters.delete('2026-Spring2');
    semesters.delete('2027-Spring1');
    semesters.delete('2027-Spring2');
    const sorted = [...semesters].sort().reverse();
    const current = activeFilters.semester || '';
    const optionsHtml = '<option value="">전체 학기</option>' + sorted.map(s => {
        return `<option value="${esc(s)}"${s === current ? ' selected' : ''}>${esc(s)}</option>`;
    }).join('');
    // 사이드바 + 모바일 드롭다운 모두 업데이트
    ['semester-filter', 'semester-filter-mobile'].forEach(id => {
        const sel = document.getElementById(id);
        if (sel) { sel.innerHTML = optionsHtml; sel.value = current; }
    });
    // localStorage에서 복원된 값이 유효한 학기인지 확인
    if (activeFilters.semester && !semesters.has(activeFilters.semester)) {
        activeFilters.semester = null;
        localStorage.removeItem('semesterFilter');
        syncSemesterDropdowns('');
    }
}

function renderStudentList(students, contactResults) {
    const listContainer = document.querySelector('.list-items');
    listContainer.innerHTML = '';
    updateCount(students.length);

    const hasContacts = contactResults && contactResults.length > 0;

    if (students.length === 0 && !hasContacts) {
        listContainer.innerHTML = '<p style="padding:16px;color:var(--text-sec)">No matches found.</p>';
        return;
    }

    if (groupViewMode !== 'none') {
        renderGroupedList(students, listContainer);
        // 그룹 모드에서도 contacts 표시
        if (hasContacts) renderContactResults(contactResults, listContainer);
        return;
    }

    students.forEach(s => renderStudentItem(s, listContainer));

    if (hasContacts) renderContactResults(contactResults, listContainer);
}

function renderStudentItem(s, container) {
    const div = document.createElement('div');
    div.className = 'list-item' + (bulkMode ? ' bulk-mode' : '') + (selectedStudentIds.has(s.id) ? ' bulk-selected' : '');
    div.dataset.id = s.id;
    const branch = activeBranchesFromStudent(s).join(', ') || branchFromStudent(s);
    const schoolShort = abbreviateSchool(s);
    const subLine = [branch, schoolShort !== '—' ? schoolShort : ''].filter(Boolean).join(' · ');
    const tags = activeClassCodes(s).map(c => `<span class="item-tag">${esc(c)}</span>`).join('') || '<span class="item-tag">—</span>';

    // 등원요일 표시
    const dayOrder = ['월','화','수','목','금','토','일'];
    const todayIdx = new Date().getDay(); // 0=일,1=월...
    const todayKr = ['일','월','화','수','목','금','토'][todayIdx];
    const days = activeDays(s);
    const dayDots = dayOrder.filter(d => days.includes(d))
        .map(d => `<span class="item-day-dot${d === todayKr ? ' today' : ''}">${d}</span>`).join('');

    // 상태 뱃지
    const status = s.status || '';
    const statusClass = status === '재원' ? 'st-active' : status === '등원예정' ? 'st-scheduled' : status === '실휴원' || status === '가휴원' ? 'st-paused' : status === '퇴원' ? 'st-withdrawn' : '';
    const statusBadge = status ? `<span class="item-status ${statusClass}">${esc(status)}</span>` : '';

    // 형제 아이콘
    const hasSibling = siblingMap[s.id] && siblingMap[s.id].size > 0;
    const siblingNames = hasSibling ? [...siblingMap[s.id]].map(sid => allStudents.find(x => x.id === sid)?.name).filter(Boolean).join(', ') : '';
    const siblingIcon = hasSibling ? `<span class="item-icon item-icon-sibling" title="형제: ${esc(siblingNames)}"><span class="material-symbols-outlined">group</span></span>` : '';

    // 메모 아이콘
    const hasMemo = memoCache[s.id];
    const memoIcon = hasMemo ? `<span class="item-icon item-icon-memo" title="메모 있음"><span class="material-symbols-outlined">sticky_note_2</span></span>` : '';

    // 휴원종료일 표시 (실휴원/가휴원인 경우)
    let pauseDateHtml = '';
    if ((status === '실휴원' || status === '가휴원') && s.pause_end_date) {
        const endDate = new Date(s.pause_end_date); endDate.setHours(0,0,0,0);
        const now = new Date(); now.setHours(0,0,0,0);
        const isOverdue = endDate < now;
        const mm = String(endDate.getMonth() + 1).padStart(2, '0');
        const dd = String(endDate.getDate()).padStart(2, '0');
        pauseDateHtml = `<span class="item-pause-date${isOverdue ? ' overdue' : ''}">${isOverdue ? '⚠ ' : ''}~${mm}/${dd}</span>`;
    }

    div.innerHTML = `
        <input type="checkbox" class="list-item-checkbox" ${selectedStudentIds.has(s.id) ? 'checked' : ''}>
        <span class="material-symbols-outlined drag-icon">person</span>
        <div class="item-main">
            <span class="item-title">${esc(s.name || '—')}${siblingIcon}${memoIcon}${statusBadge}</span>
            <span class="item-desc">${esc(subLine || '—')}</span>
        </div>
        ${pauseDateHtml}
        <div class="item-days">${dayDots}</div>
        <div class="item-tags">${tags}</div>
    `;
    const checkbox = div.querySelector('.list-item-checkbox');
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            selectedStudentIds.add(s.id);
            div.classList.add('bulk-selected');
        } else {
            selectedStudentIds.delete(s.id);
            div.classList.remove('bulk-selected');
        }
        updateBulkBar();
    });
    div.addEventListener('click', (e) => {
        if (bulkMode) {
            // 벌크 모드에서는 클릭으로 체크/해제
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
            return;
        }
        selectStudent(s.id, s, e.currentTarget);
    });
    container.appendChild(div);
}

function renderContactResults(contacts, container) {
    const PAST_LIMIT = 50;
    // 구분 헤더
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="group-label">과거 학생</span><span class="group-count">${contacts.length}명</span>`;
    container.appendChild(header);

    const visible = contacts.length <= PAST_LIMIT ? contacts : contacts.slice(0, PAST_LIMIT);
    const renderContact = (c) => {
        const div = document.createElement('div');
        div.className = 'list-item contact-item';
        div.dataset.contactId = c.id;
        const schoolShort = abbreviateSchool(c);
        const phone = c.parent_phone_1 || c.student_phone || '';
        const last4 = phone.replace(/\D/g, '').slice(-4);
        const sub = [schoolShort !== '—' ? schoolShort : '', last4 ? `☎${last4}` : ''].filter(Boolean).join(' · ');

        div.innerHTML = `
            <span class="material-symbols-outlined drag-icon" style="color:var(--text-sec)">person_off</span>
            <div class="item-main">
                <span class="item-title">${esc(c.name || '—')}<span class="item-status st-contact">과거</span></span>
                <span class="item-desc">${esc(sub || '—')}</span>
            </div>
        `;
        div.addEventListener('click', () => {
            // 등록 폼에 자동채움
            window.showNewStudentForm();
            setTimeout(() => {
                const f = document.getElementById('new-student-form');
                if (!f) return;
                f.name.value = c.name || '';
                if (c.level) f.level.value = c.level;
                if (c.school) f.school.value = c.school;
                if (c.grade) f.grade.value = c.grade;
                if (c.student_phone) f.student_phone.value = c.student_phone;
                if (c.parent_phone_1) f.parent_phone_1.value = c.parent_phone_1;
                if (c.parent_phone_2) f.parent_phone_2.value = c.parent_phone_2;
                if (c.level && window.handleLevelChange) window.handleLevelChange(c.level);
            }, 50);
        });
        return div;
    };

    visible.forEach(c => container.appendChild(renderContact(c)));

    if (contacts.length > PAST_LIMIT) {
        const moreBtn = document.createElement('div');
        moreBtn.className = 'list-item';
        moreBtn.style.cssText = 'justify-content:center;cursor:pointer;color:var(--primary)';
        moreBtn.innerHTML = `<span>+ ${contacts.length - PAST_LIMIT}명 더보기</span>`;
        moreBtn.addEventListener('click', () => {
            moreBtn.remove();
            contacts.slice(PAST_LIMIT).forEach(c => container.appendChild(renderContact(c)));
        });
        container.appendChild(moreBtn);
    }
}

function renderGroupedList(students, container) {
    const groups = {};
    students.forEach(s => {
        if (groupViewMode === 'branch') {
            const branches = activeBranchesFromStudent(s);
            const keys = branches.length > 0 ? branches : ['미지정'];
            keys.forEach(key => {
                if (!groups[key]) groups[key] = [];
                groups[key].push(s);
            });
        } else {
            const codes = activeClassCodes(s);
            const key = codes.length ? codes[0] : '미지정';
            if (!groups[key]) groups[key] = [];
            groups[key].push(s);
        }
    });

    // 그룹 키 정렬
    const sortedKeys = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ko'));

    sortedKeys.forEach(key => {
        const header = document.createElement('div');
        header.className = 'group-header';
        header.innerHTML = `<span class="group-label">${esc(key)}</span><span class="group-count">${groups[key].length}명</span>`;
        container.appendChild(header);
        groups[key].forEach(s => renderStudentItem(s, container));
    });
}

window.toggleGroupView = () => {
    const modes = ['none', 'branch', 'class'];
    const labels = { none: 'view_agenda', branch: 'location_city', class: 'school' };
    const titles = { none: '그룹 뷰 (반별)', branch: '그룹 뷰: 소속별 → 반별로 전환', class: '그룹 뷰: 반별 → 해제' };
    const idx = modes.indexOf(groupViewMode);
    groupViewMode = modes[(idx + 1) % modes.length];
    const btn = document.getElementById('group-view-btn');
    if (btn) {
        btn.textContent = labels[groupViewMode];
        btn.title = titles[groupViewMode];
        btn.classList.toggle('active', groupViewMode !== 'none');
    }
    applyFilterAndRender();
};

function updateCount(n) {
    const el = document.getElementById('student-count');
    if (!el) return;
    el.textContent = n === null ? '—' : `${n}명`;
}

// ---------------------------------------------------------------------------
// Sidebar filter nav
// ---------------------------------------------------------------------------
document.querySelectorAll('.nav-item[data-filter-type]').forEach(item => {
    item.addEventListener('click', () => {
        const type = item.dataset.filterType;
        const value = item.dataset.filterValue || null;

        if (type === 'all') {
            // 전체 초기화 (semester는 sticky — 유지)
            const keepSemester = activeFilters.semester;
            Object.keys(activeFilters).forEach(k => activeFilters[k] = null);
            activeFilters.semester = keepSemester;
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
        } else {
            if (activeFilters[type] === value) {
                // 같은 항목 재클릭 → 해제
                activeFilters[type] = null;
                item.classList.remove('active');
            } else {
                // 같은 타입의 기존 선택 해제 후 새 값 선택
                document.querySelector(`.nav-item[data-filter-type="${CSS.escape(type)}"].active`)?.classList.remove('active');
                activeFilters[type] = value;
                item.classList.add('active');
            }
            // All Students 하이라이트 제거
            document.querySelector('.menu-l1[data-filter-type="all"]')?.classList.remove('active');
        }

        applyFilterAndRender();
    });
});

// ---------------------------------------------------------------------------
// 홈 화면 토글 — 모든 L1 <details>가 닫히면 홈 화면 표시
// ---------------------------------------------------------------------------
function checkHomeView() {
    const l1Groups = document.querySelectorAll('.sidebar > details.l1-group');
    const anyOpen = [...l1Groups].some(d => d.open);
    const homeView = document.getElementById('home-view');
    const panelHeader = document.querySelector('.list-panel > .panel-header');
    const listItems = document.querySelector('.list-items');
    const statsView = document.getElementById('daily-stats-view');

    if (!homeView) return;

    if (!anyOpen && !(statsView && statsView.style.display !== 'none')) {
        homeView.style.display = 'flex';
        if (panelHeader) panelHeader.style.display = 'none';
        if (listItems) listItems.style.display = 'none';
        const bulkBar = document.getElementById('bulk-action-bar');
        if (bulkBar) bulkBar.style.display = 'none';
    } else {
        homeView.style.display = 'none';
        if (panelHeader) panelHeader.style.display = '';
        if (listItems) listItems.style.display = '';
    }
}

document.querySelectorAll('.sidebar > details.l1-group').forEach(details => {
    details.addEventListener('toggle', () => {
        // L1이 열리면 필터 초기화 후 해당 섹션 활성화
        if (details.open) {
            const homeView = document.getElementById('home-view');
            if (homeView) homeView.style.display = 'none';
            document.querySelector('.list-panel > .panel-header').style.display = '';
            document.querySelector('.list-items').style.display = '';
        }
        checkHomeView();
    });
});

// ---------------------------------------------------------------------------
// Sidebar toggle (모바일/태블릿)
// ---------------------------------------------------------------------------
{
    const _menuBtn = document.querySelector('.app-bar-left .icon-btn[aria-label="메뉴"]');
    const _sidebar = document.querySelector('.sidebar');
    const _overlay = document.getElementById('sidebarOverlay');
    const _mobileQuery = window.matchMedia('(max-width: 1024px)');

    function toggleSidebar() {
        const open = _sidebar?.classList.toggle('open');
        _overlay?.classList.toggle('open', open);
    }

    _menuBtn?.addEventListener('click', toggleSidebar);
    _overlay?.addEventListener('click', toggleSidebar);

    // 사이드바 내 필터 클릭 시 자동 닫기
    _sidebar?.addEventListener('click', (e) => {
        if (e.target.closest('.nav-item')) {
            if (_mobileQuery.matches) toggleSidebar();
        }
    });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
// 검색 입력 debounce (200ms) — 매 키 입력마다 전체 렌더링 방지
let _searchDebounceTimer = null;
const _searchInput = document.getElementById('studentSearchInput');
const _searchClearBtn = document.getElementById('searchClearBtn');

function _toggleSearchClear() {
    _searchClearBtn?.classList.toggle('visible', _searchInput.value.length > 0);
}

_searchInput?.addEventListener('input', () => {
    _toggleSearchClear();
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(applyFilterAndRender, 200);
});

_searchClearBtn?.addEventListener('click', () => {
    _searchInput.value = '';
    _toggleSearchClear();
    _searchInput.focus();
    applyFilterAndRender();
});

_searchClearBtn?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _searchClearBtn.click();
    }
});

// ---------------------------------------------------------------------------
// 등록 폼: 이름 + 전화번호로 contacts 자동채움
// ---------------------------------------------------------------------------
{
    const _form = document.getElementById('new-student-form');
    const _nameInput = _form?.querySelector('[name="name"]');
    const _phoneInput = _form?.querySelector('[name="parent_phone_1"]');
    let _lastFilledDocId = null; // 중복 채움 방지

    function _tryContactAutofill() {
        if (isEditMode) return;
        const name = _nameInput?.value.trim();
        const phone = _phoneInput?.value.trim();
        if (!name || !phone) return;

        const docId = makeDocId(name, phone);
        if (docId === _lastFilledDocId) return;

        const contact = allContacts.find(c => c.id === docId);
        if (!contact) return;

        _lastFilledDocId = docId;
        // contact 정보로 빈 필드 채움
        if (contact.level) _form.level.value = contact.level;
        if (contact.school && !_form.school.value) _form.school.value = contact.school;
        if (contact.grade && !_form.grade.value) _form.grade.value = contact.grade;
        if (contact.student_phone && !_form.student_phone.value) _form.student_phone.value = contact.student_phone;
        if (contact.parent_phone_2 && !_form.parent_phone_2.value) _form.parent_phone_2.value = contact.parent_phone_2;
        if (contact.level && window.handleLevelChange) window.handleLevelChange(contact.level);

        // 자동채움 알림 (잠깐 표시)
        const hint = document.getElementById('contact-autofill-hint');
        if (hint) {
            hint.textContent = `연락처에서 "${contact.name}" 정보를 불러왔습니다`;
            hint.style.display = 'block';
            setTimeout(() => { hint.style.display = 'none'; }, 3000);
        }
    }

    // 이름·전화번호 둘 다 입력 후 자동채움 시도
    _phoneInput?.addEventListener('change', _tryContactAutofill);
    _phoneInput?.addEventListener('blur', _tryContactAutofill);
    _nameInput?.addEventListener('change', _tryContactAutofill);

    // 폼 초기화 시 상태 리셋
    const origShowNewForm = window.showNewStudentForm;
    window.showNewStudentForm = (...args) => {
        _lastFilledDocId = null;
        return origShowNewForm?.(...args);
    };
}

// ---------------------------------------------------------------------------
// Select a student — populate detail panel
// ---------------------------------------------------------------------------
window.selectStudent = (studentId, studentData, targetElement) => {
    currentStudentId = studentId;

    // 모바일: 디테일 패널 오버레이 표시
    document.querySelector('.detail-panel').classList.add('active');

    // 폼이 열려 있으면 조회 모드로 초기화
    isEditMode = false;
    document.getElementById('form-header').style.display = 'none';
    document.getElementById('detail-form').style.display = 'none';
    document.getElementById('detail-header').style.display = 'flex';
    document.getElementById('detail-tab-bar').style.display = 'flex';
    switchDetailTab('info');

    document.getElementById('profile-initial').textContent = studentData.name?.[0] || 'S';
    document.getElementById('profile-name').textContent = studentData.name || studentId;
    const branch = activeBranchesFromStudent(studentData).join(', ') || branchFromStudent(studentData);
    const schoolShort = abbreviateSchool(studentData);
    document.getElementById('profile-school').textContent = branch && schoolShort !== '—'
        ? `${branch} · ${schoolShort}`
        : branch || schoolShort;
    document.getElementById('profile-status').textContent = studentData.status || '—';

    // 기본 정보 카드
    document.getElementById('detail-level-name').textContent = studentData.level || '—';
    document.getElementById('detail-school-name').textContent = studentData.school || '—';
    document.getElementById('detail-grade').textContent = studentData.grade ? `${studentData.grade}학년` : '—';

    // 연락처 카드
    document.getElementById('profile-student-phone').textContent = studentData.student_phone || '—';
    document.getElementById('profile-parent-phone-1').textContent = studentData.parent_phone_1 || '—';
    document.getElementById('profile-parent-phone-2').textContent = studentData.parent_phone_2 || '—';

    // 수업 정보 카드
    document.getElementById('profile-branch').textContent = branch || '—';
    document.getElementById('detail-status').textContent = studentData.status || '—';
    document.getElementById('profile-day').textContent = displayDays(activeDays(studentData));

    const pauseRow = document.getElementById('profile-pause-row');
    if (pauseRow) {
        if (studentData.status === '실휴원' || studentData.status === '가휴원') {
            const pStart = studentData.pause_start_date || '?';
            const pEnd = studentData.pause_end_date || '?';
            document.getElementById('profile-pause-period').textContent = `${formatDate(pStart)} ~ ${formatDate(pEnd)}`;
            pauseRow.style.display = 'block';
        } else {
            pauseRow.style.display = 'none';
        }
    }

    // enrollment 카드 렌더링
    renderEnrollmentCards(studentData);

    // 재원 현황 렌더링
    renderStayStats(studentData);

    document.querySelectorAll('.list-item').forEach(el => el.classList.remove('active'));
    if (targetElement) targetElement.classList.add('active');

    // 메모 로드
    loadMemos(studentId);
};

// ---------------------------------------------------------------------------
// docId generator (import-students.js와 동일한 방식)
// ---------------------------------------------------------------------------
const makeDocId = (name, parentPhone) => {
    let phone = (parentPhone || '').replace(/\D/g, '');
    // 한국 전화번호 정규화: 010XXXXXXXX → 10XXXXXXXX (기존 데이터 형식에 맞춤)
    if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);
    return `${name}_${phone}`.replace(/\s+/g, '_');
};

// ---------------------------------------------------------------------------
// 신규 등록 폼 표시 / 숨김
// ---------------------------------------------------------------------------
window.showNewStudentForm = () => {
    isEditMode = false;
    currentStudentId = null;
    pauseAlertTriggered = false;
    document.querySelectorAll('.list-item').forEach(el => el.classList.remove('active'));
    document.getElementById('detail-header').style.display = 'none';
    document.getElementById('form-header').style.display = 'flex';
    document.getElementById('detail-tab-bar').style.display = 'none';
    document.getElementById('form-title').textContent = '신규 등록';
    setFormCardTitles('기본 정보', '연락처', '수업 정보');
    document.getElementById('detail-view').style.display = 'none';
    document.getElementById('history-view').style.display = 'none';
    document.getElementById('detail-form').style.display = 'block';
    document.getElementById('new-student-form').reset();
    document.getElementById('opt-withdraw').style.display = 'none';
    document.getElementById('form-memo-list').innerHTML =
        '<p style="color:var(--text-sec);font-size:0.85em;">저장 후 메모를 추가할 수 있습니다.</p>';

    // static enrollment 필드 표시, 동적 목록 숨기기
    const staticFields = document.getElementById('static-enrollment-fields');
    if (staticFields) staticFields.style.display = 'block';
    const editEnrollList = document.getElementById('edit-enrollment-list');
    if (editEnrollList) { editEnrollList.style.display = 'none'; editEnrollList.innerHTML = ''; }

    // 오늘 날짜를 기본값으로
    const today = new Date().toISOString().slice(0, 10);
    document.querySelector('[name="start_date"]').value = today;

    // 수업종류: 정규 기본 → 등원일 라벨 + 날짜 제한
    const classTypeSelect = document.querySelector('[name="class_type"]');
    if (classTypeSelect) classTypeSelect.value = '정규';
    if (window.handleFormClassTypeChange) window.handleFormClassTypeChange();
    // 시작일 날짜 제한
    applyDateConstraints(document.querySelector('[name="start_date"]'), document.querySelector('[name="special_end_date"]'));

    if (window.handleStatusChange) window.handleStatusChange('재원');

    // 학기 드롭다운 초기화 — 사이드바 필터 또는 마지막 선택한 학기를 기본값으로 사용
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
};

// 학부 변경 시 학기 드롭다운 갱신
window.handleLevelChange = (level) => {
    const initSemSelect = document.getElementById('initial-semester-select');
    const _defSem = activeFilters.semester || localStorage.getItem('lastSelectedSemester') || '';
    if (initSemSelect) initSemSelect.innerHTML = getSemesterOptions(level, _defSem);
};

window.handleStatusChange = (val) => {
    const el = document.getElementById('pause-period-container');
    if (el) {
        el.style.display = (val === '실휴원' || val === '가휴원') ? 'block' : 'none';
        if (val === '실휴원' || val === '가휴원') {
            const startInput = document.querySelector('[name="pause_start_date"]');
            if (startInput) {
                const minStart = new Date();
                minStart.setMonth(minStart.getMonth() - 1);
                startInput.min = minStart.toISOString().split('T')[0];
            }
        }
    }
};

// ---------------------------------------------------------------------------
// 정보 수정 폼 표시
// ---------------------------------------------------------------------------
window.showEditForm = () => {
    if (!currentStudentId) return;
    const student = allStudents.find(s => s.id === currentStudentId);
    if (!student) return;

    pauseAlertTriggered = false;
    isEditMode = true;
    document.getElementById('detail-header').style.display = 'none';
    document.getElementById('form-header').style.display = 'flex';
    document.getElementById('detail-tab-bar').style.display = 'none';
    document.getElementById('form-title').textContent = '정보 수정';

    // 카드 타이틀 변경
    setFormCardTitles('기본정보 변경', '연락처 변경', '수업 정보 추가 및 변경');
    document.getElementById('detail-view').style.display = 'none';
    document.getElementById('history-view').style.display = 'none';
    document.getElementById('detail-form').style.display = 'block';

    const f = document.getElementById('new-student-form');
    f.reset();

    // Pre-fill 기본 정보 + 연락처
    f.name.value = student.name || '';
    f.level.value = student.level || '초등';
    f.school.value = student.school || '';
    f.grade.value = student.grade || '';
    f.student_phone.value = student.student_phone || '';
    f.parent_phone_1.value = student.parent_phone_1 || '';
    f.parent_phone_2.value = student.parent_phone_2 || '';

    // 신규등록 static 필드 숨기고 동적 enrollment 카드 표시
    const staticFields = document.getElementById('static-enrollment-fields');
    if (staticFields) staticFields.style.display = 'none';
    // 학기 필터가 있으면 해당 학기 enrollment만 표시, 없으면 활성 enrollment만
    const editEnrolls = activeFilters.semester
        ? (student.enrollments || []).filter(e => e.semester === activeFilters.semester)
        : getActiveEnrollments(student);
    renderEditableEnrollments(editEnrolls);

    // 상태
    document.getElementById('opt-withdraw').style.display = 'block';
    f.status.value = student.status || '재원';
    f.pause_start_date.value = student.pause_start_date || '';
    f.pause_end_date.value = student.pause_end_date || '';
    if (window.handleStatusChange) window.handleStatusChange(f.status.value);

    // 수정 모드: pending enrollments 숨김, 수업 추가 버튼은 addEditEnrollment로
    const pendingContainer = document.getElementById('form-pending-enrollments');
    if (pendingContainer) { pendingContainer.style.display = 'none'; pendingContainer.innerHTML = ''; }
    const addEnrollBtn = document.getElementById('form-add-enrollment-btn');
    if (addEnrollBtn) {
        addEnrollBtn.style.display = 'flex';
        addEnrollBtn.onclick = window.addEditEnrollment;
    }

    loadFormMemos(currentStudentId);
};

window.hideForm = () => {
    isEditMode = false;
    document.getElementById('form-header').style.display = 'none';
    document.getElementById('detail-header').style.display = 'flex';
    document.getElementById('detail-tab-bar').style.display = 'flex';
    document.getElementById('detail-form').style.display = 'none';
    // 동적 enrollment 목록 초기화
    const editEnrollList = document.getElementById('edit-enrollment-list');
    if (editEnrollList) { editEnrollList.style.display = 'none'; editEnrollList.innerHTML = ''; }
    _editEnrollments = [];
    // static 필드 복원
    const staticFields = document.getElementById('static-enrollment-fields');
    if (staticFields) staticFields.style.display = 'block';
    // 카드 타이틀 초기화
    setFormCardTitles('기본 정보', '연락처', '수업 정보');
    switchDetailTab('info');
};

// ---------------------------------------------------------------------------
// 신규 등록 / 정보 수정 저장
// ---------------------------------------------------------------------------
window.submitNewStudent = async () => {
    if (isEditMode && isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const f = document.getElementById('new-student-form');
    const name = f.name.value.trim();
    const parentPhone1 = f.parent_phone_1.value.trim();

    if (!name) { alert('이름을 입력하세요.'); return; }
    if (!parentPhone1) { alert('학부모 연락처를 입력하세요.'); return; }

    let studentData;

    if (isEditMode) {
        // 수정 모드: 기본 정보 + 상태 + 동적 enrollment 카드에서 수집
        const oldStudent = allStudents.find(s => s.id === currentStudentId) || {};
        const editedEnrollments = collectEditEnrollments();
        // 편집에서 제외된 다른 학기 enrollment 보존
        const editedSemesters = new Set(editedEnrollments.map(e => e.semester).filter(Boolean));
        const otherEnrollments = (oldStudent.enrollments || []).filter(e => {
            if (!e.semester) return false;
            // 현재 편집 대상이었던 학기의 enrollment은 제외 (편집 결과로 대체)
            if (activeFilters.semester) return e.semester !== activeFilters.semester;
            // 학기 필터 없이 활성 enrollment만 편집한 경우: 편집된 학기와 겹치지 않는 것만 보존
            return !editedSemesters.has(e.semester);
        });
        const updatedEnrollments = [...editedEnrollments, ...otherEnrollments];
        const firstClassNumber = updatedEnrollments[0]?.class_number || '';
        const branch = branchFromClassNumber(firstClassNumber) || oldStudent.branch || '';

        studentData = {
            name,
            level: f.level.value,
            school: f.school.value.trim(),
            grade: f.grade.value.trim().replace(/[^0-9]/g, ''),
            student_phone: f.student_phone.value.trim(),
            parent_phone_1: parentPhone1,
            parent_phone_2: f.parent_phone_2.value.trim(),
            branch,
            status: f.status.value,
            enrollments: updatedEnrollments,
            // 레거시 flat 필드 정리 (enrollments 배열로 이관 완료)
            day: deleteField(),
            class_type: deleteField(),
            level_code: deleteField(),
            level_symbol: deleteField(),
            class_number: deleteField(),
            start_date: deleteField(),
            special_start_date: deleteField(),
            special_end_date: deleteField(),
        };
        // 휴원 상태일 때만 휴원 날짜 저장, 아니면 기존 값 유지
        const statusVal = f.status.value;
        if (statusVal === '실휴원' || statusVal === '가휴원') {
            studentData.pause_start_date = f.pause_start_date.value;
            studentData.pause_end_date = f.pause_end_date.value;
        }
    } else {
        // 신규 등록: 첫 enrollment 포함
        const classNumber = f.class_number.value.trim();
        const branch = branchFromClassNumber(classNumber);

        if (!branch) { alert('반넘버를 입력하세요. (1xx: 2단지, 2xx: 10단지)'); return; }

        const days = Array.from(f.querySelectorAll('[name="day"]:checked')).map(cb => cb.value);
        const classType = f.class_type.value;
        const levelSymbol = f.level_symbol.value.trim();

        const initialEnrollment = {
            class_type: classType,
            level_symbol: levelSymbol,
            class_number: classNumber,
            day: days,
            start_date: f.start_date.value,
            semester: f.initial_semester?.value || '',
        };
        // 선택한 학기를 기억하여 다음 등록 시 기본값으로 사용
        if (initialEnrollment.semester) {
            localStorage.setItem('lastSelectedSemester', initialEnrollment.semester);
        }
        if (classType !== '정규' && f.special_end_date.value) {
            initialEnrollment.end_date = f.special_end_date.value;
        }

        // 폼 enrollment + 추가 수업 목록 합치기
        const allEnrollments = [initialEnrollment, ..._pendingEnrollments];

        studentData = {
            name,
            level: f.level.value,
            school: f.school.value.trim(),
            grade: f.grade.value.trim().replace(/[^0-9]/g, ''),
            student_phone: f.student_phone.value.trim(),
            parent_phone_1: parentPhone1,
            parent_phone_2: f.parent_phone_2.value.trim(),
            branch,
            status: f.status.value,
            pause_start_date: '',
            pause_end_date: '',
            enrollments: allEnrollments,
        };
        // 휴원 상태일 때만 휴원 날짜 저장
        if (f.status.value === '실휴원' || f.status.value === '가휴원') {
            studentData.pause_start_date = f.pause_start_date.value;
            studentData.pause_end_date = f.pause_end_date.value;
        }
    }

    const saveBtn = document.getElementById('save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';

    try {
        if (isEditMode) {
            const docId = currentStudentId;
            const oldStudent = allStudents.find(s => s.id === docId) || {};

            const oldCodes = allClassCodes(oldStudent).join(', ') || '—';
            const newCodes = (studentData.enrollments || []).map(e => enrollmentCode(e)).filter(Boolean).join(', ') || '—';
            const beforeStr = `상태:${oldStudent.status || ''}, 반:${oldCodes}, 요일:${displayDays(combinedDays(oldStudent))}`;
            const newDays = [...new Set((studentData.enrollments || []).flatMap(e => normalizeDays(e.day)))];
            const afterStr = `상태:${studentData.status}, 반:${newCodes}, 요일:${displayDays(newDays)}`;

            await setDoc(doc(db, 'students', docId), studentData, { merge: true });
            await addDoc(collection(db, 'history_logs'), {
                doc_id: docId,
                change_type: 'UPDATE',
                before: beforeStr,
                after: afterStr,
                google_login_id: currentUser?.email || 'system',
                timestamp: serverTimestamp(),
            });
        } else {
            const docId = makeDocId(name, parentPhone1);
            const existingStudent = allStudents.find(s => s.id === docId);
            if (existingStudent) {
                // Student exists — add new enrollments to existing doc
                const newEnrollments = studentData.enrollments || [];
                const mergedEnrollments = [...(existingStudent.enrollments || []), ...newEnrollments];
                await setDoc(doc(db, 'students', docId), { ...studentData, enrollments: mergedEnrollments }, { merge: true });
                await addDoc(collection(db, 'history_logs'), {
                    doc_id: docId,
                    change_type: 'UPDATE',
                    before: `수업: ${allClassCodes(existingStudent).join(', ') || '—'}`,
                    after: `수업 추가: ${newEnrollments.map(e => enrollmentCode(e)).join(', ')}`,
                    google_login_id: currentUser?.email || 'system',
                    timestamp: serverTimestamp(),
                });
            } else {
                await setDoc(doc(db, 'students', docId), studentData);
                const codes = allClassCodes(studentData).join(', ') || '—';
                await addDoc(collection(db, 'history_logs'), {
                    doc_id: docId,
                    change_type: 'ENROLL',
                    before: '—',
                    after: `신규 등록: ${name} (${codes})`,
                    google_login_id: currentUser?.email || 'system',
                    timestamp: serverTimestamp(),
                });
            }
            currentStudentId = docId;
        }

        // contacts 컬렉션에도 기본정보 동기화 (실패해도 학생 저장에 영향 없음)
        try {
            const contactDocId = isEditMode ? currentStudentId : makeDocId(name, parentPhone1);
            const contactData = {
                name,
                level: studentData.level || '',
                school: studentData.school || '',
                grade: studentData.grade || '',
                student_phone: studentData.student_phone || '',
                parent_phone_1: studentData.parent_phone_1 || parentPhone1,
                parent_phone_2: studentData.parent_phone_2 || '',
                updated_at: serverTimestamp(),
            };
            await setDoc(doc(db, 'contacts', contactDocId), contactData, { merge: true });
            // 로컬 캐시 갱신
            const idx = allContacts.findIndex(c => c.id === contactDocId);
            const merged = { id: contactDocId, ...contactData };
            if (idx >= 0) Object.assign(allContacts[idx], merged);
            else allContacts.push(merged);
        } catch (contactErr) {
            console.warn('[CONTACTS SYNC]', contactErr);
        }

        _pendingEnrollments = [];
        hideForm();

        // 저장 성공 후 UI 갱신 — 여기서의 에러는 저장과 무관하므로 별도 처리
        try {
            await loadStudentList();
            const savedStudent = allStudents.find(s => s.id === currentStudentId);
            if (savedStudent) {
                const targetEl = document.querySelector(`.list-item[data-id="${CSS.escape(currentStudentId)}"]`);
                selectStudent(savedStudent.id, savedStudent, targetEl);
            }
        } catch (refreshErr) {
            console.warn('[POST-SAVE REFRESH]', refreshErr);
        }
    } catch (err) {
        console.error('[SAVE ERROR]', err);
        alert('저장 실패: ' + err.message);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '저장';
    }
};

// 날짜 제한 공통: 시작일은 오늘-1개월~, 종료일은 시작일+3개월 이내
const applyDateConstraints = (startInput, endInput) => {
    if (!startInput) return;
    const today = new Date();
    const minStart = new Date(today);
    minStart.setMonth(minStart.getMonth() - 1);
    startInput.min = minStart.toISOString().split('T')[0];

    if (endInput) {
        const syncEnd = () => {
            if (startInput.value) {
                endInput.min = startInput.value;
                const maxEnd = new Date(startInput.value);
                maxEnd.setMonth(maxEnd.getMonth() + 3);
                endInput.max = maxEnd.toISOString().split('T')[0];
            }
        };
        startInput.addEventListener('change', syncEnd);
        syncEnd();
    }
};

// 신규등록 폼: 수업종류 변경 시 날짜 필드 전환
window.handleFormClassTypeChange = () => {
    const val = document.querySelector('[name="class_type"]')?.value;
    const isRegular = val === '정규';
    const specialEl = document.getElementById('special-period-container');
    const startDateEl = document.getElementById('start-date-container');
    const startLabel = startDateEl?.querySelector('.field-label');
    if (specialEl) specialEl.style.display = isRegular ? 'none' : 'block';
    if (startDateEl) startDateEl.style.display = 'block';
    if (startLabel) startLabel.textContent = isRegular ? '등원일' : '시작일';

    // 날짜 제한 적용
    const startInput = document.querySelector('[name="start_date"]');
    const endInput = document.querySelector('[name="special_end_date"]');
    applyDateConstraints(startInput, endInput);
};

// 수업 모달 학기 드롭다운 공통 채우기
function _populateEnrollmentSemester(level) {
    const sel = document.getElementById('enroll-semester-select');
    const def = activeFilters.semester || localStorage.getItem('lastSelectedSemester') || '';
    if (sel) sel.innerHTML = getSemesterOptions(level, def);
}

// 신규등록 폼: 수업 추가 모달 열기 (enrollment-modal 재사용, 로컬 저장)
window.openFormEnrollmentModal = () => {
    const modal = document.getElementById('enrollment-modal');
    if (!modal) return;
    const form = document.getElementById('enrollment-form');
    if (form) form.reset();
    const today = new Date().toISOString().slice(0, 10);
    const startInput = modal.querySelector('[name="enroll_start_date"]');
    if (startInput) startInput.value = today;
    const specContainer = document.getElementById('enroll-special-period');
    if (specContainer) specContainer.style.display = 'none';
    const startLabel = document.querySelector('#enroll-start-date-container .field-label');
    if (startLabel) startLabel.textContent = '등원일';
    const endInput = modal.querySelector('[name="enroll_end_date"]');
    applyDateConstraints(startInput, endInput);
    // 학부에 맞는 학기 옵션 채우기
    _populateEnrollmentSemester(document.getElementById('new-student-form')?.level?.value || '');
    // 모달 데이터 속성으로 컨텍스트 표시 (form = 신규등록 폼에서 호출)
    modal.dataset.context = 'form';
    modal.style.display = 'flex';
};

// 추가 수업 목록 렌더링
function renderPendingEnrollments() {
    const container = document.getElementById('form-pending-enrollments');
    if (!container) return;
    if (_pendingEnrollments.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = 'flex';
    container.innerHTML = _pendingEnrollments.map((e, idx) => {
        const code = enrollmentCode(e);
        const days = displayDays(e.day);
        return `<div class="pending-enrollment-card">
            <span class="enrollment-tag">${esc(code)}</span>
            <span class="pending-enrollment-info">${esc(e.class_type)} · ${esc(days)}</span>
            <button type="button" class="btn-remove-pending" onclick="window.removePendingEnrollment(${idx})" title="삭제">
                <span class="material-symbols-outlined" style="font-size:16px;">close</span>
            </button>
        </div>`;
    }).join('');
}

window.removePendingEnrollment = (idx) => {
    _pendingEnrollments.splice(idx, 1);
    renderPendingEnrollments();
};

// 반넘버 입력 시 소속 자동 표시
window.handleClassNumberChange = (val) => {
    const branch = branchFromClassNumber(val);
    const branchPreview = document.getElementById('branch-preview');
    if (branchPreview) branchPreview.textContent = branch ? `(${branch})` : '';
};

// ---------------------------------------------------------------------------
// 수정 폼: 동적 enrollment 편집 카드 렌더링
// ---------------------------------------------------------------------------

function renderEditableEnrollments(enrollments) {
    _editEnrollments = enrollments.map(e => ({ ...e })); // deep copy
    const container = document.getElementById('edit-enrollment-list');
    if (!container) return;
    container.style.display = 'flex';
    _rebuildEditEnrollmentCards();
}

function _rebuildEditEnrollmentCards() {
    const container = document.getElementById('edit-enrollment-list');
    if (!container) return;
    container.innerHTML = '';

    const student = allStudents.find(s => s.id === currentStudentId);
    const studentLevel = student?.level || '';

    _editEnrollments.forEach((e, idx) => {
        const code = enrollmentCode(e);
        const ct = e.class_type || '정규';
        const isRegular = ct === '정규';
        const days = normalizeDays(e.day);
        const dayCheckboxes = ['월', '화', '수', '목', '금', '토', '일'].map(d =>
            `<label class="day-check"><input type="checkbox" name="edit_day_${idx}" value="${d}" ${days.includes(d) ? 'checked' : ''}>${d}</label>`
        ).join('');

        const card = document.createElement('div');
        card.className = 'edit-enrollment-card';
        card.innerHTML = `
            <div class="edit-enrollment-header">
                <span class="enrollment-tag">${esc(code || '새 수업')}</span>
                <span class="enrollment-type">${esc(ct)}</span>
                <button type="button" class="btn-remove-pending" onclick="window.removeEditEnrollment(${idx})" title="수업 삭제">
                    <span class="material-symbols-outlined" style="font-size:16px;">close</span>
                </button>
            </div>
            <div class="form-fields" style="gap:12px;">
                <div class="form-row">
                    <div class="form-field">
                        <label class="field-label">레벨기호</label>
                        <input class="field-input" data-field="level_symbol" data-idx="${idx}" type="text" placeholder="HA" value="${esc(e.level_symbol || '')}">
                    </div>
                    <div class="form-field">
                        <label class="field-label">반넘버</label>
                        <input class="field-input" data-field="class_number" data-idx="${idx}" type="text" placeholder="101,201"
                            inputmode="numeric" value="${esc(e.class_number || '')}"
                            oninput="this.value=this.value.replace(/[^0-9]/g,'')">
                    </div>
                </div>
                <div class="form-field">
                    <label class="field-label">수업종류</label>
                    <select class="field-select" data-field="class_type" data-idx="${idx}"
                        onchange="window.handleEditEnrollClassType(${idx}, this.value)">
                        <option value="정규" ${ct === '정규' ? 'selected' : ''}>정규</option>
                        <option value="특강" ${ct === '특강' ? 'selected' : ''}>특강</option>
                        <option value="내신" ${ct === '내신' ? 'selected' : ''}>내신</option>
                    </select>
                </div>
                <div class="form-field">
                    <label class="field-label">요일</label>
                    <div class="day-checkboxes">${dayCheckboxes}</div>
                </div>
                <div class="form-field">
                    <label class="field-label">${isRegular ? '등원일' : '시작일'}</label>
                    <input class="field-input" data-field="start_date" data-idx="${idx}" type="date" value="${e.start_date || ''}">
                </div>
                <div class="form-field" style="display:${isRegular ? 'none' : 'block'}">
                    <label class="field-label">종료일</label>
                    <input class="field-input" data-field="end_date" data-idx="${idx}" type="date" value="${e.end_date || ''}">
                </div>
                <div class="form-field">
                    <label class="field-label">학기</label>
                    <select class="field-select" data-field="semester" data-idx="${idx}">
                        ${getSemesterOptions(studentLevel, e.semester || '')}
                    </select>
                </div>
            </div>
        `;
        container.appendChild(card);

        // 날짜 제한 적용
        const startInput = card.querySelector('[data-field="start_date"]');
        const endInput = card.querySelector('[data-field="end_date"]');
        applyDateConstraints(startInput, endInput);
    });

    if (_editEnrollments.length === 0) {
        container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;">수업이 없습니다. 아래 버튼으로 추가하세요.</p>';
    }
}

// 수정 폼: 수업종류 변경 시 날짜 라벨/표시 전환
window.handleEditEnrollClassType = (idx, val) => {
    const container = document.getElementById('edit-enrollment-list');
    if (!container) return;
    const cards = container.querySelectorAll('.edit-enrollment-card');
    const card = cards[idx];
    if (!card) return;
    const isRegular = val === '정규';
    const startLabel = card.querySelector('[data-field="start_date"]')?.closest('.form-field')?.querySelector('.field-label');
    if (startLabel) startLabel.textContent = isRegular ? '등원일' : '시작일';
    const endField = card.querySelector('[data-field="end_date"]')?.closest('.form-field');
    if (endField) endField.style.display = isRegular ? 'none' : 'block';
};

window.removeEditEnrollment = (idx) => {
    _editEnrollments.splice(idx, 1);
    _rebuildEditEnrollmentCards();
};

// 수정 폼에서 수업 추가 (enrollment modal 재사용)
window.addEditEnrollment = () => {
    const modal = document.getElementById('enrollment-modal');
    if (!modal) return;
    const form = document.getElementById('enrollment-form');
    if (form) form.reset();
    const today = new Date().toISOString().slice(0, 10);
    const startInput = modal.querySelector('[name="enroll_start_date"]');
    if (startInput) startInput.value = today;
    const specContainer = document.getElementById('enroll-special-period');
    if (specContainer) specContainer.style.display = 'none';
    const startLabel = document.querySelector('#enroll-start-date-container .field-label');
    if (startLabel) startLabel.textContent = '등원일';
    const endInput = modal.querySelector('[name="enroll_end_date"]');
    applyDateConstraints(startInput, endInput);
    // 학기 드롭다운 채우기
    const student = allStudents.find(s => s.id === currentStudentId);
    _populateEnrollmentSemester(student?.level || '');
    modal.dataset.context = 'edit';
    modal.style.display = 'flex';
};

// 수정 폼에서 현재 편집 중인 enrollment 데이터 수집
function collectEditEnrollments() {
    const container = document.getElementById('edit-enrollment-list');
    if (!container) return [];
    const cards = container.querySelectorAll('.edit-enrollment-card');
    return Array.from(cards).map((card, idx) => {
        const get = (field) => card.querySelector(`[data-field="${CSS.escape(field)}"]`)?.value?.trim() || '';
        const days = Array.from(card.querySelectorAll(`input[type="checkbox"][name="edit_day_${idx}"]:checked`)).map(cb => cb.value);
        const classType = get('class_type');
        const enrollment = {
            class_type: classType,
            level_symbol: get('level_symbol'),
            class_number: get('class_number'),
            day: days,
            start_date: get('start_date'),
            semester: get('semester'),
        };
        if (classType !== '정규') {
            const endDate = get('end_date');
            if (endDate) enrollment.end_date = endDate;
        }
        return enrollment;
    });
}

// ---------------------------------------------------------------------------
// Enrollment 카드 렌더링 (상세 뷰)
// ---------------------------------------------------------------------------
function renderEnrollmentCards(studentData) {
    const container = document.getElementById('enrollment-list');
    if (!container) return;
    container.innerHTML = '';

    const enrollments = studentData.enrollments || [];
    if (enrollments.length === 0) {
        container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;">수업 정보가 없습니다.</p>';
        return;
    }

    // 학기 필터 있으면 해당 학기만, 없으면 활성 enrollment만
    const visibleEnrollments = activeFilters.semester
        ? enrollments.filter(e => e.semester === activeFilters.semester)
        : getActiveEnrollments(studentData);

    if (visibleEnrollments.length === 0) {
        container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;">해당 학기 수업 정보가 없습니다.</p>';
        return;
    }

    visibleEnrollments.forEach((e) => {
        const realIdx = enrollments.indexOf(e);
        _renderEnrollmentCard(container, e, realIdx, false);
    });
}

function _renderEnrollmentCard(container, e, idx, isHistory) {
    const code = enrollmentCode(e);
    const days = displayDays(e.day);
    const ct = e.class_type || '정규';
    const isRegular = ct === '정규';
    const semLabel = e.semester || '';
    const card = document.createElement('div');
    card.className = `enrollment-card${isHistory ? ' enrollment-history' : ''}`;
    card.innerHTML = `
        <div class="enrollment-card-header">
            <span class="enrollment-tag">${esc(code)}</span>
            <span class="enrollment-type">${esc(ct)}</span>
            ${semLabel ? `<span class="enrollment-semester">${esc(semLabel)}</span>` : ''}
            ${!isRegular && !isHistory ? `<button class="btn-end-class" onclick="window.endEnrollment(${idx})" title="종강처리">종강처리</button>` : ''}
        </div>
        <div class="enrollment-card-body">
            <div class="enrollment-field"><span class="field-label">요일</span><span>${esc(days)}</span></div>
            <div class="enrollment-field"><span class="field-label">${isRegular ? '등원일' : '시작일'}</span><span>${esc(formatDate(e.start_date))}</span></div>
            ${e.end_date ? `<div class="enrollment-field"><span class="field-label">종료일</span><span>${esc(formatDate(e.end_date))}</span></div>` : ''}
        </div>
    `;
    container.appendChild(card);
}

// ---------------------------------------------------------------------------
// 재원 현황 (재원기간 + 레벨 이력)
// ---------------------------------------------------------------------------
function renderStayStats(studentData) {
    const container = document.getElementById('stay-stats');
    if (!container) return;

    const enrollments = (studentData.enrollments || []).filter(e => e.level_symbol || e.start_date);
    if (!enrollments.length) {
        container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;">수업 이력 없음</p>';
        return;
    }

    // ── 재원기간 ──
    const startDates = enrollments.map(e => e.start_date).filter(d => d && d !== '?' && /^\d{4}-/.test(d)).sort();
    let periodHtml = '—';
    if (startDates.length) {
        const start = new Date(startDates[0]);
        const now = new Date();
        const totalMonths = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
        const years = Math.floor(totalMonths / 12);
        const months = totalMonths % 12;
        const duration = totalMonths <= 0
            ? '등원예정'
            : years > 0
                ? `${years}년${months > 0 ? ' ' + months + '개월' : ''}`
                : `${totalMonths}개월`;
        periodHtml = `${formatDate(startDates[0])} 부터 &nbsp;·&nbsp; <strong>${duration}</strong>`;
    }

    // ── 레벨 이력 (현재 활성 enrollment 제외, 과거 학기만) ──
    const activeSet = new Set(getActiveEnrollments(studentData));
    const levelMap = {};
    for (const e of enrollments) {
        if (activeSet.has(e)) continue; // 현재 학기 제외
        const sym = e.level_symbol;
        if (!sym) continue;
        if (!levelMap[sym]) levelMap[sym] = { semesters: new Set(), firstDate: '' };
        if (e.semester) levelMap[sym].semesters.add(e.semester);
        if (e.start_date && (!levelMap[sym].firstDate || e.start_date < levelMap[sym].firstDate))
            levelMap[sym].firstDate = e.start_date;
    }

    const levelRows = Object.entries(levelMap)
        .sort((a, b) => (a[1].firstDate || '').localeCompare(b[1].firstDate || ''))
        .map(([sym, data]) => {
            const sems = [...data.semesters].sort();
            const semStr = sems.length ? sems.join(' · ') : '—';
            const cnt = sems.length;
            return `<div class="stay-level-row">
                <span class="stay-level-tag">${esc(sym)}</span>
                <span class="stay-level-sems">${esc(semStr)}</span>
                <span class="stay-level-count">${cnt}학기</span>
            </div>`;
        }).join('');

    container.innerHTML = `
        <div class="form-field">
            <span class="field-label">재원기간</span>
            <div class="field-value">${periodHtml}</div>
        </div>
        ${levelRows ? `<div class="form-field">
            <span class="field-label">레벨 이력</span>
            <div class="stay-level-list">${levelRows}</div>
        </div>` : ''}
    `;
}

// ---------------------------------------------------------------------------
// 수업 추가 모달
// ---------------------------------------------------------------------------
window.openEnrollmentModal = () => {
    if (!currentStudentId) return;
    const modal = document.getElementById('enrollment-modal');
    if (!modal) return;
    // 폼 리셋
    const form = document.getElementById('enrollment-form');
    if (form) form.reset();
    const today = new Date().toISOString().slice(0, 10);
    const startInput = modal.querySelector('[name="enroll_start_date"]');
    if (startInput) startInput.value = today;
    // 기본 정규 → 등원일, 종료일 숨김
    const specContainer = document.getElementById('enroll-special-period');
    if (specContainer) specContainer.style.display = 'none';
    const startLabel = document.querySelector('#enroll-start-date-container .field-label');
    if (startLabel) startLabel.textContent = '등원일';
    // 날짜 제한
    const endInput = modal.querySelector('[name="enroll_end_date"]');
    applyDateConstraints(startInput, endInput);
    // 학부에 맞는 학기 옵션 채우기
    const student = allStudents.find(s => s.id === currentStudentId);
    _populateEnrollmentSemester(student?.level || '');
    delete modal.dataset.context;
    modal.style.display = 'flex';
};

window.closeEnrollmentModal = (e) => {
    if (e && e.target !== document.getElementById('enrollment-modal')) return;
    const modal = document.getElementById('enrollment-modal');
    modal.style.display = 'none';
    delete modal.dataset.context;
};

window.handleEnrollClassTypeChange = () => {
    const val = document.querySelector('#enrollment-form [name="enroll_class_type"]')?.value;
    const isRegular = val === '정규';
    const specContainer = document.getElementById('enroll-special-period');
    const startContainer = document.getElementById('enroll-start-date-container');
    const startLabel = startContainer?.querySelector('.field-label');
    if (specContainer) specContainer.style.display = isRegular ? 'none' : 'block';
    if (startContainer) startContainer.style.display = 'block';
    if (startLabel) startLabel.textContent = isRegular ? '등원일' : '시작일';

    // 날짜 제한 적용
    const startInput = document.querySelector('#enrollment-form [name="enroll_start_date"]');
    const endInput = document.querySelector('#enrollment-form [name="enroll_end_date"]');
    applyDateConstraints(startInput, endInput);
};

window.saveEnrollment = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const modal = document.getElementById('enrollment-modal');
    const form = document.getElementById('enrollment-form');
    const classType = form.enroll_class_type.value;
    const levelSymbol = form.enroll_level_symbol.value.trim();
    const classNumber = form.enroll_class_number.value.trim();
    const days = Array.from(form.querySelectorAll('[name="enroll_day"]:checked')).map(cb => cb.value);
    const startDate = form.enroll_start_date.value;
    const endDate = form.enroll_end_date?.value || '';

    if (!classNumber) { alert('반넘버를 입력하세요.'); return; }

    const semester = form.enroll_semester?.value || '';
    const enrollment = { class_type: classType, level_symbol: levelSymbol, class_number: classNumber, day: days, start_date: startDate, semester };
    if (classType !== '정규' && endDate) enrollment.end_date = endDate;

    // 신규등록 폼에서 호출된 경우 → 로컬 배열에 추가
    if (modal?.dataset.context === 'form') {
        _pendingEnrollments.push(enrollment);
        renderPendingEnrollments();
        modal.style.display = 'none';
        delete modal.dataset.context;
        return;
    }

    // 수정 폼에서 호출된 경우 → 편집 중 배열에 추가
    if (modal?.dataset.context === 'edit') {
        _editEnrollments.push(enrollment);
        _rebuildEditEnrollmentCards();
        modal.style.display = 'none';
        delete modal.dataset.context;
        return;
    }

    // 기존 학생 수업 추가 (Firestore 저장)
    if (!currentStudentId) return;

    try {
        const student = allStudents.find(s => s.id === currentStudentId);
        if (!student) return;
        const updatedEnrollments = [...(student.enrollments || []), enrollment];

        // branch 업데이트 (첫 번째 enrollment 기준)
        const branch = branchFromClassNumber(updatedEnrollments[0].class_number);

        await setDoc(doc(db, 'students', currentStudentId), { enrollments: updatedEnrollments, branch }, { merge: true });
        await addDoc(collection(db, 'history_logs'), {
            doc_id: currentStudentId,
            change_type: 'UPDATE',
            before: '—',
            after: `수업 추가: ${enrollmentCode(enrollment)} (${classType})`,
            google_login_id: currentUser?.email || 'system',
            timestamp: serverTimestamp(),
        });

        modal.style.display = 'none';
        await loadStudentList();
        const savedStudent = allStudents.find(s => s.id === currentStudentId);
        if (savedStudent) {
            const targetEl = document.querySelector(`.list-item[data-id="${CSS.escape(currentStudentId)}"]`);
            selectStudent(savedStudent.id, savedStudent, targetEl);
        }
    } catch (err) {
        alert('수업 추가 실패: ' + err.message);
    }
};

// ---------------------------------------------------------------------------
// 종강 처리 — 동일 수업을 듣는 모든 학생 일괄 종강
// ---------------------------------------------------------------------------
let _endClassTarget = null; // { code, classType, affectedStudents[] }

window.endEnrollment = (idx) => {
    if (!currentStudentId) return;
    const student = allStudents.find(s => s.id === currentStudentId);
    if (!student || !student.enrollments?.[idx]) return;

    const e = student.enrollments[idx];
    const code = enrollmentCode(e);
    const classType = e.class_type;

    // 이 수업(code + classType)을 듣는 모든 학생 찾기
    const affected = allStudents.filter(s =>
        (s.enrollments || []).some(en => enrollmentCode(en) === code && en.class_type === classType)
    );

    // 종강 후 다른 수업이 남는 학생 / 퇴원될 학생 분류
    const willKeep = [];
    const willWithdraw = [];
    affected.forEach(s => {
        const remaining = (s.enrollments || []).filter(en => !(enrollmentCode(en) === code && en.class_type === classType));
        if (remaining.length > 0) willKeep.push(s);
        else willWithdraw.push(s);
    });

    _endClassTarget = { code, classType, affected, willKeep, willWithdraw, currentStudentId: currentStudentId, enrollIdx: idx };

    // 모달 내용 구성
    const modal = document.getElementById('end-class-modal');
    if (!modal) return;

    document.getElementById('end-class-title').textContent = `${code} (${classType}) 종강처리`;
    const bodyEl = document.getElementById('end-class-body');

    // 현재 학생 정보
    const currentS = student;
    const currentRemaining = (currentS.enrollments || []).filter((_, i) => i !== idx);
    const currentWillWithdraw = currentRemaining.length === 0;

    let html = `<p class="end-class-summary"><strong>${esc(currentS.name)}</strong>의 <strong>${esc(code)}</strong> (${esc(classType)}) 수업을 종강 처리합니다.</p>`;

    if (currentWillWithdraw) {
        html += `<p class="end-class-warn">이 학생은 다른 수업이 없어 <strong>퇴원</strong> 처리됩니다.</p>`;
    }

    if (affected.length > 1) {
        html += `<div class="end-class-group" style="margin-top:12px;">
            <span class="end-class-group-label">전체 종강 시 영향받는 학생 (${affected.length}명)</span>
            <ul class="end-class-list">${affected.map(s => {
            const rem = (s.enrollments || []).filter(en => !(enrollmentCode(en) === code && en.class_type === classType));
            const isW = rem.length === 0;
            return `<li>${esc(s.name)}${isW ? '<span class="end-class-remaining" style="background:#fce8e6;color:#c5221f;">퇴원</span>' : `<span class="end-class-remaining">${rem.map(e => enrollmentCode(e)).filter(Boolean).join(', ')}</span>`}</li>`;
        }).join('')}</ul>
        </div>`;
    }

    bodyEl.innerHTML = html;
    modal.style.display = 'flex';
};

window.closeEndClassModal = (e) => {
    if (e && e.target !== document.getElementById('end-class-modal')) return;
    document.getElementById('end-class-modal').style.display = 'none';
    _endClassTarget = null;
};

window.confirmEndClassSingle = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    if (!_endClassTarget) return;
    const { code, classType, currentStudentId: studentId, enrollIdx } = _endClassTarget;
    const modal = document.getElementById('end-class-modal');
    const singleBtn = document.getElementById('end-class-single-btn');

    singleBtn.disabled = true;
    singleBtn.textContent = '처리 중...';

    try {
        const student = allStudents.find(s => s.id === studentId);
        if (!student) return;

        const remaining = (student.enrollments || []).filter((_, i) => i !== enrollIdx);
        const isWithdraw = remaining.length === 0;
        const branch = remaining.length ? branchFromClassNumber(remaining[0].class_number) : (student.branch || '');

        const updateData = { enrollments: remaining, branch };
        if (isWithdraw) updateData.status = '퇴원';

        await setDoc(doc(db, 'students', studentId), updateData, { merge: true });
        await addDoc(collection(db, 'history_logs'), {
            doc_id: studentId,
            change_type: isWithdraw ? 'WITHDRAW' : 'UPDATE',
            before: `수업: ${code} (${classType})`,
            after: isWithdraw
                ? `종강 처리: ${code} (${classType}) → 퇴원 (다른 수업 없음)`
                : `종강 처리: ${code} (${classType})`,
            google_login_id: currentUser?.email || 'system',
            timestamp: serverTimestamp(),
        });

        modal.style.display = 'none';
        _endClassTarget = null;

        await loadStudentList();
        if (currentStudentId) {
            const savedStudent = allStudents.find(s => s.id === currentStudentId);
            if (savedStudent) {
                const targetEl = document.querySelector(`.list-item[data-id="${CSS.escape(currentStudentId)}"]`);
                selectStudent(savedStudent.id, savedStudent, targetEl);
            }
        }
    } catch (err) {
        alert('종강 처리 실패: ' + err.message);
    } finally {
        singleBtn.disabled = false;
        singleBtn.textContent = '해당 학생만';
    }
};

window.confirmEndClass = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    if (!_endClassTarget) return;
    const { code, classType, affected, willWithdraw } = _endClassTarget;
    const modal = document.getElementById('end-class-modal');
    const confirmBtn = document.getElementById('end-class-confirm-btn');

    confirmBtn.disabled = true;
    confirmBtn.textContent = '처리 중...';
    const singleBtn = document.getElementById('end-class-single-btn');
    if (singleBtn) singleBtn.disabled = true;

    try {
        const BATCH_SIZE = 200;
        for (let i = 0; i < affected.length; i += BATCH_SIZE) {
            const chunk = affected.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);

            chunk.forEach(s => {
                const remaining = (s.enrollments || []).filter(en => !(enrollmentCode(en) === code && en.class_type === classType));
                const isWithdraw = remaining.length === 0;
                const branch = remaining.length ? branchFromClassNumber(remaining[0].class_number) : (s.branch || '');

                const updateData = { enrollments: remaining, branch };
                if (isWithdraw) {
                    updateData.status = '퇴원';
                }

                batch.set(doc(db, 'students', s.id), updateData, { merge: true });

                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: s.id,
                    change_type: isWithdraw ? 'WITHDRAW' : 'UPDATE',
                    before: `수업: ${code} (${classType})`,
                    after: isWithdraw
                        ? `종강 처리: ${code} (${classType}) → 퇴원 (다른 수업 없음)`
                        : `종강 처리: ${code} (${classType})`,
                    google_login_id: currentUser?.email || 'system',
                    timestamp: serverTimestamp(),
                });
            });

            await batch.commit();
        }

        modal.style.display = 'none';
        _endClassTarget = null;

        await loadStudentList();
        // 현재 선택된 학생 다시 표시
        if (currentStudentId) {
            const savedStudent = allStudents.find(s => s.id === currentStudentId);
            if (savedStudent) {
                const targetEl = document.querySelector(`.list-item[data-id="${CSS.escape(currentStudentId)}"]`);
                selectStudent(savedStudent.id, savedStudent, targetEl);
            }
        }
    } catch (err) {
        alert('종강 처리 실패: ' + err.message);
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '전체 종강처리';
        const sBtn = document.getElementById('end-class-single-btn');
        if (sBtn) { sBtn.disabled = false; sBtn.textContent = '해당 학생만'; }
    }
};

let pauseAlertTriggered = false;

window.checkDurationLimit = () => {
    const startInput = document.querySelector('[name="pause_start_date"]');
    const endInput = document.querySelector('[name="pause_end_date"]');

    if (startInput && endInput) {
        if (startInput.value) {
            endInput.min = startInput.value;
            const startDate = new Date(startInput.value);
            const maxDate = new Date(startDate);
            maxDate.setFullYear(startDate.getFullYear() + 1);
            endInput.max = maxDate.toISOString().split('T')[0];
        }

        if (startInput.value && endInput.value) {
            const start = new Date(startInput.value);
            const end = new Date(endInput.value);
            const diffTime = end - start;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays > 31) {
                if (!pauseAlertTriggered) {
                    alert('휴원은 한달까지만 가능합니다.');
                    pauseAlertTriggered = true;
                }
            } else {
                pauseAlertTriggered = false;
            }
        }
    }
};

// ---------------------------------------------------------------------------
// Google Sheets Export / Import (GAS Web App 연동)
// ---------------------------------------------------------------------------
window.handleSheetExport = async () => {
    const exportStudents = currentFilteredStudents ?? allStudents;
    if (!exportStudents || exportStudents.length === 0) {
        alert('내보낼 데이터가 없습니다.');
        return;
    }
    const token = getGoogleAccessToken();
    if (!token) {
        alert('구글 드라이브 접근 권한이 필요합니다.\n로그아웃 후 다시 로그인해주세요.');
        return;
    }

    const EXPORT_HEADERS = STUDENT_SHEET_HEADERS;

    // exportStudents → enrollment 단위 행으로 변환 (GAS studentsToRows와 동일)
    const dataRows = [];
    exportStudents.forEach(s => {
        const enrollments = s.enrollments || [];
        const branch = s.branch || '';
        if (enrollments.length === 0) {
            dataRows.push([
                s.name || '', s.level || '', s.school || '', s.grade || '',
                s.student_phone || '', s.parent_phone_1 || '', s.parent_phone_2 || '',
                s.guardian_name_1 || '', s.guardian_name_2 || '',
                branch, '', '', '정규', '', '', '',
                s.status || '재원', s.pause_start_date || '', s.pause_end_date || '', '', s.first_registered || ''
            ]);
        } else {
            enrollments.forEach(e => {
                const dayStr = Array.isArray(e.day) ? e.day.join(',') : (e.day || '');
                dataRows.push([
                    s.name || '', s.level || '', s.school || '', s.grade || '',
                    s.student_phone || '', s.parent_phone_1 || '', s.parent_phone_2 || '',
                    s.guardian_name_1 || '', s.guardian_name_2 || '',
                    branch,
                    e.level_symbol || '', e.class_number || '', e.class_type || '정규',
                    e.start_date || '', e.end_date || '', dayStr,
                    s.status || '재원', s.pause_start_date || '', s.pause_end_date || '', e.semester || '', s.first_registered || ''
                ]);
            });
        }
    });

    try {
        // 1. 스프레드시트 생성 + 헤더 + 데이터 한번에
        const today = new Date().toISOString().slice(0, 10);
        const sheetTitle = `impact7DB_${today}${hasNonSemesterFilter() ? '_필터적용' : ''}`;
        const headerRow = {
            values: EXPORT_HEADERS.map(h => ({
                userEnteredValue: { stringValue: h },
                userEnteredFormat: {
                    textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
                    backgroundColorStyle: { rgbColor: { red: 0.263, green: 0.522, blue: 0.957 } }
                }
            }))
        };
        const bodyRows = dataRows.map(row => ({
            values: row.map(cell => ({ userEnteredValue: { stringValue: String(cell) } }))
        }));

        const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                properties: { title: sheetTitle },
                sheets: [{
                    properties: { title: '학생데이터', gridProperties: { frozenRowCount: 1 } },
                    data: [{ startRow: 0, startColumn: 0, rowData: [headerRow, ...bodyRows] }]
                }]
            })
        });

        if (!createResp.ok) throw new Error(await createResp.text());
        const created = await createResp.json();
        const sid = created.sheets[0].properties.sheetId;

        // 2. 필터 + 열 자동 맞춤 (실패해도 시트 자체는 생성됨)
        const totalRows = dataRows.length + 1;
        const fmtResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${created.spreadsheetId}:batchUpdate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [
                { setBasicFilter: { filter: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: EXPORT_HEADERS.length } } } },
                { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: EXPORT_HEADERS.length } } }
            ]})
        });
        if (!fmtResp.ok) console.warn('[EXPORT] 서식 설정 실패:', await fmtResp.text());

        window.open(created.spreadsheetUrl, '_blank');
    } catch (e) {
        alert('시트 내보내기 실패: ' + e.message + '\n\n로그아웃 후 다시 로그인하면 해결될 수 있습니다.');
    }
};

window.handleUpload = () => {
    document.getElementById('upload-modal').style.display = 'flex';
};

window.closeUploadModal = (e) => {
    if (e && e.target !== document.getElementById('upload-modal')) return;
    document.getElementById('upload-modal').style.display = 'none';
};

window.handleSheetUrlUpload = () => {
    const url = prompt('구글시트 URL을 붙여넣으세요:\n(예: https://docs.google.com/spreadsheets/d/...)');
    if (!url) return;
    const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) {
        if (url.includes('script.google.com')) {
            alert('스크립트 URL은 사용할 수 없습니다.\n\n구글시트가 열린 후 주소창의 URL을 복사하세요.\n(docs.google.com/spreadsheets/d/... 형식)\n\n또는 "드라이브에서 선택"을 이용하세요.');
        } else {
            alert('올바른 구글시트 URL이 아닙니다.\n\nURL 형식: https://docs.google.com/spreadsheets/d/...');
        }
        return;
    }
    importFromSheetId(m[1], '시트 업로드');
};

window.handleSheetTemplate = async () => {
    const token = getGoogleAccessToken();
    if (!token) {
        alert('구글 드라이브 접근 권한이 필요합니다.\n로그아웃 후 다시 로그인해주세요.');
        return;
    }

    const TMPL_HEADERS = STUDENT_SHEET_HEADERS;

    try {
        // 1. 사용자 드라이브에 스프레드시트 생성
        const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                properties: { title: 'impact7DB_가져오기_템플릿' },
                sheets: [{
                    properties: { title: '데이터입력', gridProperties: { frozenRowCount: 1 } },
                    data: [{
                        startRow: 0, startColumn: 0,
                        rowData: [{
                            values: TMPL_HEADERS.map(h => ({
                                userEnteredValue: { stringValue: h },
                                userEnteredFormat: {
                                    textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
                                    backgroundColorStyle: { rgbColor: { red: 0.204, green: 0.659, blue: 0.325 } }
                                }
                            }))
                        }]
                    }]
                }]
            })
        });

        if (!createResp.ok) throw new Error(await createResp.text());
        const created = await createResp.json();
        const sid = created.sheets[0].properties.sheetId;
        const R = 101; // endRowIndex (100행)

        // 2. 데이터 유효성 + 날짜 서식 설정
        const mkList = (start, end, vals, strict) => ({
            setDataValidation: {
                range: { sheetId: sid, startRowIndex: 1, endRowIndex: R, startColumnIndex: start, endColumnIndex: end },
                rule: { condition: { type: 'ONE_OF_LIST', values: vals.map(v => ({ userEnteredValue: v })) }, showCustomUi: true, strict }
            }
        });
        const mkDate = (col) => ({
            repeatCell: {
                range: { sheetId: sid, startRowIndex: 1, endRowIndex: R, startColumnIndex: col, endColumnIndex: col + 1 },
                cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
                fields: 'userEnteredFormat.numberFormat'
            }
        });

        const valResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${created.spreadsheetId}:batchUpdate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [
                mkList(1, 2, ['초등', '중등', '고등'], true),
                mkList(10, 11, ['정규', '특강', '내신'], true),
                mkList(14, 15, ['등원예정', '재원', '실휴원', '가휴원', '퇴원'], true),
                mkList(17, 18, [
                    '2026-Winter','2026-Spring','2026-Summer','2026-Autumn',
                    '2027-Winter','2027-Spring','2027-Summer','2027-Autumn'
                ], false),
                mkDate(11), mkDate(12), mkDate(15), mkDate(16),
                { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: TMPL_HEADERS.length } } }
            ]})
        });
        if (!valResp.ok) console.warn('[TEMPLATE] 유효성 설정 실패:', await valResp.text());

        window.open(created.spreadsheetUrl, '_blank');
        alert('내 드라이브에 템플릿이 생성되었습니다!\n\n데이터를 입력한 후:\n• "시트 URL로 업로드" → 주소창 URL 붙여넣기\n• "드라이브에서 선택" → 템플릿 파일 선택');
    } catch (e) {
        alert('템플릿 생성 실패: ' + e.message + '\n\n로그아웃 후 다시 로그인하면 해결될 수 있습니다.');
    }
};

// Google Picker — 드라이브에서 구글시트 선택 → 바로 가져오기
let _pickerApiLoaded = false;

function loadPickerApi() {
    return new Promise((resolve) => {
        if (_pickerApiLoaded) { resolve(); return; }
        gapi.load('picker', () => { _pickerApiLoaded = true; resolve(); });
    });
}

window.handleSheetPicker = async () => {
    if (!getGoogleAccessToken()) {
        alert('구글 드라이브 접근 권한이 필요합니다.\n로그아웃 후 다시 로그인해주세요.');
        return;
    }

    await loadPickerApi();

    const picker = new google.picker.PickerBuilder()
        .setTitle('가져올 구글시트를 선택하세요')
        .addView(
            new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
                .setMode(google.picker.DocsViewMode.LIST)
        )
        .setOAuthToken(getGoogleAccessToken())
        .setCallback(async (data) => {
            if (data.action !== google.picker.Action.PICKED) return;
            const sheetId = data.docs[0].id;
            const sheetName = data.docs[0].name;
            await importFromSheetId(sheetId, sheetName);
        })
        .build();

    picker.setVisible(true);
};

async function importFromSheetId(sheetId, sheetName) {
    try {
        const token = getGoogleAccessToken();
        if (!token) { alert('구글 드라이브 접근 권한이 필요합니다.\n로그아웃 후 다시 로그인해주세요.'); return; }

        // 시트 탭 목록 조회
        const metaResp = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (!metaResp.ok) { alert('시트 읽기 실패: ' + await metaResp.text()); return; }
        const meta = await metaResp.json();
        const tabs = meta.sheets.map(s => s.properties.title);

        let selectedTab = tabs[0];
        if (tabs.length > 1) {
            const tabList = tabs.map((t, i) => `${i + 1}. ${t}`).join('\n');
            const choice = prompt(`"${sheetName}"에 탭이 ${tabs.length}개 있습니다.\n가져올 탭 번호를 입력하세요:\n\n${tabList}`);
            if (!choice) return;
            const idx = parseInt(choice, 10) - 1;
            if (idx < 0 || idx >= tabs.length) { alert('올바른 번호를 입력해주세요.'); return; }
            selectedTab = tabs[idx];
        }

        if (!confirm(`"${sheetName}" → [${selectedTab}] 탭에서 데이터를 가져올까요?`)) return;

        // 선택된 탭에서 데이터 읽기
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(selectedTab)}!A:Z`;
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });

        if (!resp.ok) { alert('시트 읽기 실패: ' + await resp.text()); return; }

        const data = await resp.json();
        const sheetRows = data.values;
        if (!sheetRows || sheetRows.length < 2) {
            alert('시트에 데이터가 없습니다.');
            return;
        }

        // GAS 템플릿 헤더 → 통합 upsert 필드명 매핑
        const sheetHeaders = sheetRows[0];
        const headerMap = {
            // English (primary)
            'name': 'name', 'level': 'level', 'school': 'school', 'grade': 'grade',
            'student_phone': 'student_phone', 'parent_phone_1': 'parent_phone_1', 'parent_phone_2': 'parent_phone_2',
            'guardian_name_1': 'guardian_name_1', 'guardian_name_2': 'guardian_name_2',
            'branch': 'branch', 'level_symbol': 'level_symbol', 'class_number': 'class_number',
            'class_type': 'class_type', 'start_date': 'start_date', 'end_date': 'end_date',
            'day': 'day', 'status': 'status',
            'pause_start_date': 'pause_start_date', 'pause_end_date': 'pause_end_date', 'semester': 'semester',
            'first_registered': 'first_registered',
            // Korean (backward compat)
            '이름': 'name', '학부': 'level', '학교': 'school', '학년': 'grade',
            '학생연락처': 'student_phone', '학부모연락처1': 'parent_phone_1', '학부모연락처2': 'parent_phone_2',
            '보호자명1': 'guardian_name_1', '보호자명2': 'guardian_name_2',
            '소속': 'branch', '레벨기호': 'level_symbol', '반넘버': 'class_number',
            '수업종류': 'class_type', '시작일': 'start_date', '종료일': 'end_date',
            '요일': 'day', '상태': 'status',
            '휴원시작일': 'pause_start_date', '휴원종료일': 'pause_end_date', '학기': 'semester',
            '첫등록일': 'first_registered',
        };

        const rows = sheetRows.slice(1).map(row => {
            const obj = {};
            sheetHeaders.forEach((h, i) => {
                const key = headerMap[h] || h;
                obj[key] = (row[i] || '').toString().trim();
            });
            return obj;
        });

        await runUpsertFromRows(rows, sheetName);
    } catch (e) {
        alert('가져오기 실패: ' + e.message);
    }
}


// ---------------------------------------------------------------------------
// CSV Upsert — 브라우저에서 CSV 파일 업로드 → Firestore upsert
// ---------------------------------------------------------------------------
window.handleCsvUpsert = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            await runCsvUpsert(text, file.name);
        } catch (err) {
            alert('CSV 읽기 실패: ' + err.message);
        }
    };
    input.click();
};

async function runCsvUpsert(csvText, fileName) {
    // Parse CSV → rows
    const lines = csvText.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { alert('CSV에 데이터가 없습니다.'); return; }

    const headers = parseCSVLine(lines[0]);
    const rows = lines.slice(1).map(line => {
        const vals = parseCSVLine(line);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
        return obj;
    });

    // 영어 우선, 한글 폴백 — 영어/한글 CSV 모두 지원
    const normalized = rows.map(raw => ({
        name: raw['name'] || raw['이름'] || '',
        level: raw['level'] || raw['학부'] || '',
        school: raw['school'] || raw['학교'] || '',
        grade: raw['grade'] || raw['학년'] || '',
        student_phone: raw['student_phone'] || raw['학생연락처'] || '',
        parent_phone_1: raw['parent_phone_1'] || raw['학부모연락처1'] || '',
        parent_phone_2: raw['parent_phone_2'] || raw['학부모연락처2'] || '',
        guardian_name_1: raw['guardian_name_1'] || raw['보호자명1'] || '',
        guardian_name_2: raw['guardian_name_2'] || raw['보호자명2'] || '',
        branch: raw['branch'] || raw['소속'] || '',
        level_symbol: raw['level_symbol'] || raw['레벨기호'] || '',
        class_number: raw['class_number'] || raw['반넘버'] || '',
        class_type: raw['class_type'] || raw['수업종류'] || '정규',
        start_date: raw['start_date'] || raw['시작일'] || '',
        day: raw['day'] || raw['요일'] || '',
        status: raw['status'] || raw['상태'] || '재원',
        semester: raw['semester'] || raw['학기'] || '',
        end_date: raw['end_date'] || raw['종료일'] || '',
        pause_start_date: raw['pause_start_date'] || raw['휴원시작일'] || '',
        pause_end_date: raw['pause_end_date'] || raw['휴원종료일'] || '',
        first_registered: raw['first_registered'] || raw['첫등록일'] || '',
    }));

    await runUpsertFromRows(normalized, fileName);
}

/**
 * 공통 Upsert 로직 — CSV, 구글시트 모두 이 함수로 통합
 * rows: [{ name, level, school, grade, student_phone, parent_phone_1, parent_phone_2,
 *           guardian_name_1, guardian_name_2, branch, level_symbol, class_number,
 *           class_type, start_date, day, status, ... }]
 */
async function runUpsertFromRows(rows, sourceName) {
    if (!rows || rows.length === 0) { alert('데이터가 없습니다.'); return; }

    // Group by docId
    const studentMap = {};
    for (const raw of rows) {
        const name = raw['name'] || raw['이름'];
        const parentPhone = raw['parent_phone_1'] || raw['학부모연락처1'] || raw['student_phone'] || raw['학생연락처'] || '';
        if (!name) continue;

        const classNumber = raw['class_number'] || '';
        const branch = raw['branch'] || branchFromClassNumber(classNumber);
        const docId = makeDocId(name, parentPhone);

        const dayRaw = raw['day'] || raw['요일'] || '';
        const dayArr = dayRaw.split(/[,\s]+/).map(d => d.replace(/요일$/, '')).filter(d => d);

        const enrollment = {
            class_type: raw['class_type'] || '정규',
            level_symbol: raw['level_symbol'] || '',
            class_number: classNumber,
            day: dayArr,
            start_date: raw['start_date'] || raw['시작일'] || '',
            semester: raw['semester'] || raw['학기'] || '',
        };
        const endDate = raw['end_date'] || raw['종료일'] || '';
        if (endDate) enrollment.end_date = endDate;

        if (!studentMap[docId]) {
            studentMap[docId] = {
                name, level: raw['level'] || raw['학부'] || '', school: raw['school'] || raw['학교'] || '',
                grade: raw['grade'] || raw['학년'] || '', student_phone: raw['student_phone'] || raw['학생연락처'] || '',
                parent_phone_1: parentPhone, parent_phone_2: raw['parent_phone_2'] || raw['학부모연락처2'] || '',
                guardian_name_1: raw['guardian_name_1'] || raw['보호자명1'] || '',
                guardian_name_2: raw['guardian_name_2'] || raw['보호자명2'] || '',
                branch, status: raw['status'] || raw['상태'] || '재원',
                pause_start_date: raw['pause_start_date'] || raw['휴원시작일'] || '',
                pause_end_date: raw['pause_end_date'] || raw['휴원종료일'] || '',
                first_registered: raw['first_registered'] || raw['첫등록일'] || '',
                has_memo: false,
                enrollments: []
            };
        }

        const hasData = enrollment.level_symbol || enrollment.class_number || enrollment.start_date || dayArr.length > 0;
        if (hasData) studentMap[docId].enrollments.push(enrollment);
    }

    // Fetch existing from Firestore (already loaded in allStudents)
    // 실제 Firestore docId로 매칭 (재생성하지 않음)
    const existingMap = {};
    for (const s of allStudents) {
        existingMap[s.id] = s;
    }

    // 4) Compare and classify
    const infoFields = ['name', 'level', 'school', 'grade', 'student_phone', 'parent_phone_1', 'parent_phone_2', 'guardian_name_1', 'guardian_name_2', 'branch', 'status', 'pause_start_date', 'pause_end_date', 'first_registered'];

    const results = { inserted: [], updated: [], skipped: [] };
    const writes = [];
    const logEntries = [];

    for (const [docId, incoming] of Object.entries(studentMap)) {
        const ex = existingMap[docId];

        if (!ex) {
            // INSERT
            results.inserted.push({ docId, name: incoming.name, enrollments: incoming.enrollments });
            writes.push({ docId, data: incoming, type: 'set' });
            logEntries.push({
                doc_id: docId, change_type: 'ENROLL', before: '—',
                after: `신규 등록: ${incoming.name} (${incoming.enrollments.map(enrollmentCode).join(', ') || '수업없음'})`
            });
        } else {
            // DIFF basic info
            const infoDiff = {};
            for (const f of infoFields) {
                const oldVal = (ex[f] || '').toString().trim();
                const newVal = (incoming[f] || '').toString().trim();
                if (newVal && newVal !== oldVal) infoDiff[f] = { old: oldVal, new: newVal };
            }

            // ACCUMULATE enrollments by semester
            const incomingSemesters = new Set(incoming.enrollments.map(e => e.semester).filter(Boolean));
            const hasSemesterData = incomingSemesters.size > 0;
            const keptEnrolls = hasSemesterData
                ? (ex.enrollments || []).filter(e => !incomingSemesters.has(e.semester))
                : []; // 학기 정보 없으면 전체 교체 (중복 방지)
            const sameExisting = hasSemesterData
                ? (ex.enrollments || []).filter(e => incomingSemesters.has(e.semester))
                : (ex.enrollments || []); // 학기 정보 없으면 전체를 비교 대상으로
            const newBucket = [];
            const enrollAdded = [], enrollChanged2 = [];
            const matchedExisting = new Set();
            for (const inc of incoming.enrollments) {
                const key = enrollmentCode(inc);
                const match = hasSemesterData
                    ? sameExisting.find(e => enrollmentCode(e) === key && e.semester === inc.semester)
                    : sameExisting.find((e, i) => enrollmentCode(e) === key && !matchedExisting.has(i));
                if (!match) { newBucket.push({ ...inc }); enrollAdded.push(inc); }
                else {
                    if (!hasSemesterData) {
                        const matchIdx = sameExisting.indexOf(match);
                        matchedExisting.add(matchIdx);
                    }
                    // 기존 enrollment에 비어있지 않은 incoming 값만 덮어쓰기 (부분 업데이트 지원)
                    const merged = { ...match };
                    for (const [k, v] of Object.entries(inc)) {
                        if (k === 'day' && Array.isArray(v) && v.length === 0) continue;
                        if (v === '' || v === undefined || v === null) continue;
                        merged[k] = v;
                    }
                    if (JSON.stringify(match) !== JSON.stringify(merged)) { enrollChanged2.push(merged); newBucket.push(merged); }
                    else { newBucket.push({ ...match }); }
                }
            }
            // 학기 정보 없을 때: 매칭되지 않은 기존 enrollment도 유지
            if (!hasSemesterData) {
                sameExisting.forEach((e, i) => { if (!matchedExisting.has(i)) keptEnrolls.push(e); });
            }
            const mergedEnrollments = [...keptEnrolls, ...newBucket];
            const enrollChanged = enrollAdded.length > 0 || enrollChanged2.length > 0;

            const hasInfoChange = Object.keys(infoDiff).length > 0;

            if (!hasInfoChange && !enrollChanged) {
                results.skipped.push(docId);
                continue;
            }

            const updateData = {};
            for (const [f, v] of Object.entries(infoDiff)) updateData[f] = v.new;
            if (enrollChanged) updateData.enrollments = mergedEnrollments;

            results.updated.push({ docId, name: incoming.name, infoDiff, enrollChanged, addedCodes: enrollAdded.map(enrollmentCode).join(', '), totalEnroll: mergedEnrollments.length });
            writes.push({ docId, data: updateData, type: 'merge' });

            const bParts = [], aParts = [];
            for (const [f, v] of Object.entries(infoDiff)) { bParts.push(`${f}:${v.old || '—'}`); aParts.push(`${f}:${v.new}`); }
            if (enrollChanged) {
                if (enrollAdded.length) aParts.push(`추가: ${enrollAdded.map(enrollmentCode).join(', ')}`);
                aParts.push(`총 ${mergedEnrollments.length}개 누적`);
            }

            logEntries.push({
                doc_id: docId, change_type: 'UPDATE',
                before: bParts.join(', ') || '—', after: aParts.join(', ')
            });
        }
    }

    // 4.5) day 검증: KS/내신 아닌데 1일만 등원인 학생 경고
    const dayWarnings = [];
    for (const [docId, s] of Object.entries(studentMap)) {
        for (const e of s.enrollments) {
            const ls = (e.level_symbol || '').toUpperCase();
            if (ls !== 'KS' && e.class_type !== '내신' && Array.isArray(e.day) && e.day.length === 1) {
                dayWarnings.push(`${s.name} (${enrollmentCode(e)}): ${e.day.join(',')}`);
            }
        }
    }

    // 5) Show confirmation dialog
    let msg = `📁 ${sourceName}\n\n`;
    msg += `📥 신규 등록: ${results.inserted.length}명\n`;
    msg += `📝 정보 변경: ${results.updated.length}명\n`;
    msg += `⏭️ 변경 없음: ${results.skipped.length}명\n\n`;

    if (dayWarnings.length > 0) {
        msg += `⚠️ 등원요일 1일만 입력 (KS 제외): ${dayWarnings.length}명\n`;
        for (const w of dayWarnings.slice(0, 10)) msg += `  ⚠ ${w}\n`;
        if (dayWarnings.length > 10) msg += `  ... 외 ${dayWarnings.length - 10}명\n`;
        msg += '\n';
    }

    if (results.inserted.length > 0) {
        msg += `🆕 신규:\n`;
        for (const r of results.inserted.slice(0, 20)) msg += `  + ${r.name} (${r.enrollments.map(enrollmentCode).join(', ')})\n`;
        if (results.inserted.length > 20) msg += `  ... 외 ${results.inserted.length - 20}명\n`;
        msg += '\n';
    }
    if (results.updated.length > 0) {
        msg += `✏️ 변경:\n`;
        for (const r of results.updated.slice(0, 20)) {
            const parts = [];
            for (const [f, v] of Object.entries(r.infoDiff)) parts.push(`${f}: ${v.old}→${v.new}`);
            if (r.enrollChanged) parts.push(`수업: +${r.addedCodes || '없음'} (총 ${r.totalEnroll}개)`);
            msg += `  ~ ${r.name}: ${parts.join(', ')}\n`;
        }
        if (results.updated.length > 20) msg += `  ... 외 ${results.updated.length - 20}명\n`;
    }

    if (writes.length === 0) {
        const totalRows = Object.keys(studentMap).length;
        const firstRow = rows[0] || {};
        const detectedKeys = Object.keys(firstRow).join(', ');
        alert(
            '변경사항이 없습니다.\n\n' +
            `[진단 정보]\n` +
            `읽은 행: ${rows.length}개\n` +
            `인식된 학생: ${totalRows}명\n` +
            `건너뜀: ${results.skipped.length}명\n` +
            `헤더: ${detectedKeys || '(없음)'}`
        );
        return;
    }

    msg += `\n적용하시겠습니까?`;
    if (!confirm(msg)) return;

    // 6) Write to Firestore in batches (학생 write + history log = 2 ops/item, 500 한도)
    const BATCH_SIZE = 200;
    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
        const chunk = writes.slice(i, i + BATCH_SIZE);
        const logChunk = logEntries.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);

        for (const w of chunk) {
            const ref = doc(db, 'students', w.docId);
            if (w.type === 'set') batch.set(ref, w.data);
            else batch.set(ref, w.data, { merge: true });
        }

        for (const log of logChunk) {
            const logRef = doc(collection(db, 'history_logs'));
            batch.set(logRef, { ...log, google_login_id: currentUser?.email || 'unknown', timestamp: serverTimestamp() });
        }

        await batch.commit();
    }

    alert(`✅ 완료!\n\n신규: ${results.inserted.length}명\n변경: ${results.updated.length}명\n건너뜀: ${results.skipped.length}명`);
    await loadStudentList();
}

// 메모 모달 상태 — ESC 핸들러보다 먼저 선언
let _memoModalContext = null; // 'view' | 'form'

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const isVisible = (el) => el && el.style.display === 'flex';
        const endClassModal = document.getElementById('end-class-modal');
        if (isVisible(endClassModal)) {
            endClassModal.style.display = 'none';
            _endClassTarget = null;
            return;
        }
        const enrollModal = document.getElementById('enrollment-modal');
        if (isVisible(enrollModal)) {
            enrollModal.style.display = 'none';
            return;
        }
        const modal = document.getElementById('memo-modal');
        if (isVisible(modal)) {
            modal.style.display = 'none';
            _memoModalContext = null;
        }
    }
});

// ---------------------------------------------------------------------------
// 메모 관리 (Firestore 서브컬렉션: students/{docId}/memos/{memoId})
// ---------------------------------------------------------------------------
async function loadMemos(studentId) {
    const container = document.getElementById('memo-list');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;padding:4px 0;">로딩 중...</p>';

    try {
        const snap = await getDocs(collection(db, 'students', studentId, 'memos'));
        const memos = [];
        snap.forEach(d => memos.push({ id: d.id, ...d.data() }));
        memos.sort((a, b) => (a.created_at?.seconds || 0) - (b.created_at?.seconds || 0));
        renderMemos(memos, studentId);
    } catch (e) {
        container.innerHTML = '<p style="color:red;font-size:0.85em;">메모 로드 실패</p>';
    }
}

function renderMemos(memos, studentId) {
    const container = document.getElementById('memo-list');
    if (!container) return;
    container.innerHTML = '';

    if (memos.length === 0) {
        container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;padding:4px 0;">메모가 없습니다. + 버튼으로 추가하세요.</p>';
        return;
    }

    memos.forEach(memo => {
        const preview = (memo.text || '').slice(0, 40) + ((memo.text || '').length > 40 ? '…' : '');
        const card = document.createElement('div');
        card.className = 'memo-card';
        card.dataset.memoId = memo.id;
        card.innerHTML = `
            <div class="memo-preview">
                <span class="memo-preview-text">${esc(preview)}</span>
                <div class="memo-actions">
                    <button class="memo-delete-btn" title="삭제">
                        <span class="material-symbols-outlined" style="font-size:16px;">close</span>
                    </button>
                </div>
            </div>
            <div class="memo-full" style="display:none;">
                <div class="memo-text">${esc(memo.text || '').replace(/\n/g, '<br>')}</div>
            </div>
        `;
        // addEventListener로 XSS 방지 (studentId에 작은따옴표 등 특수문자가 포함될 수 있음)
        card.querySelector('.memo-preview').addEventListener('click', () => window.toggleMemo(memo.id));
        card.querySelector('.memo-delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            window.deleteMemo(studentId, memo.id);
        });
        container.appendChild(card);
    });
}

window.toggleMemo = (memoId) => {
    const card = document.querySelector(`.memo-card[data-memo-id="${CSS.escape(memoId)}"]`);
    if (!card) return;
    const full = card.querySelector('.memo-full');
    const isOpen = full.style.display !== 'none';
    full.style.display = isOpen ? 'none' : 'block';
    card.classList.toggle('expanded', !isOpen);
};

window.deleteMemo = async (studentId, memoId) => {
    if (!confirm('이 메모를 삭제하시겠습니까?')) return;
    try {
        await deleteDoc(doc(db, 'students', studentId, 'memos', memoId));
        // 메모 캐시 업데이트: 남은 메모가 있는지 확인
        const remaining = await getDocs(collection(db, 'students', studentId, 'memos'));
        if (remaining.empty) {
            delete memoCache[studentId];
            await setDoc(doc(db, 'students', studentId), { has_memo: false }, { merge: true });
            const st = allStudents.find(s => s.id === studentId);
            if (st) st.has_memo = false;
        }
        updateListItemIcons(studentId);
        await loadMemos(studentId);
    } catch (e) {
        alert('삭제 실패: ' + e.message);
    }
};

// ---------------------------------------------------------------------------
// 메모 모달
// ---------------------------------------------------------------------------
window.openMemoModal = (context) => {
    _memoModalContext = context;
    const modal = document.getElementById('memo-modal');
    const input = document.getElementById('memo-modal-input');
    if (!modal || !input) return;
    input.value = '';
    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 50);
};

window.closeMemoModal = (e) => {
    if (e && e.target !== document.getElementById('memo-modal')) return;
    document.getElementById('memo-modal').style.display = 'none';
    _memoModalContext = null;
};

window.saveMemoFromModal = async () => {
    const input = document.getElementById('memo-modal-input');
    const text = input?.value.trim();
    if (!text) { input?.focus(); return; }
    if (!currentStudentId) return;
    const ctx = _memoModalContext;
    try {
        const batch = writeBatch(db);
        const memoRef = doc(collection(db, 'students', currentStudentId, 'memos'));
        batch.set(memoRef, {
            text,
            created_at: serverTimestamp(),
            author: currentUser?.email || 'system',
        });
        // 학생 문서에 has_memo 플래그 설정 (메모 생성과 원자적으로 처리)
        batch.set(doc(db, 'students', currentStudentId), { has_memo: true }, { merge: true });
        await batch.commit();
        memoCache[currentStudentId] = true;
        const st = allStudents.find(s => s.id === currentStudentId);
        if (st) st.has_memo = true;
        updateListItemIcons(currentStudentId);
        document.getElementById('memo-modal').style.display = 'none';
        _memoModalContext = null;
        if (ctx === 'form') await loadFormMemos(currentStudentId);
        else await loadMemos(currentStudentId);
    } catch (e) {
        alert('메모 저장 실패: ' + e.message);
    }
};

window.addMemo = () => {
    if (!currentStudentId) return;
    window.openMemoModal('view');
};

// ---------------------------------------------------------------------------
// 폼 메모 관리 (수정 폼 전용, #form-memo-list)
// ---------------------------------------------------------------------------
async function loadFormMemos(studentId) {
    const container = document.getElementById('form-memo-list');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;">로딩 중...</p>';

    try {
        const snap = await getDocs(collection(db, 'students', studentId, 'memos'));
        const memos = [];
        snap.forEach(d => memos.push({ id: d.id, ...d.data() }));
        memos.sort((a, b) => (a.created_at?.seconds || 0) - (b.created_at?.seconds || 0));

        container.innerHTML = '';
        if (memos.length === 0) {
            container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;">메모가 없습니다. + 버튼으로 추가하세요.</p>';
            return;
        }
        memos.forEach(memo => {
            const ts = memo.created_at?.toDate?.();
            const dateStr = ts ? ts.toLocaleDateString('ko-KR') : '';
            const author = memo.author ? memo.author.replace(/@.*/, '') : '';

            const row = document.createElement('div');
            row.className = 'memo-form-item';
            row.innerHTML = `
                <div class="memo-form-meta">
                    <span>${esc(dateStr)}${author ? ' · ' + esc(author) : ''}</span>
                    <button class="memo-delete-btn" title="삭제">
                        <span class="material-symbols-outlined" style="font-size:15px;">close</span>
                    </button>
                </div>
                <div class="memo-form-text">${esc(memo.text || '').replace(/\n/g, '<br>')}</div>
            `;
            // addEventListener로 XSS 방지
            row.querySelector('.memo-delete-btn').addEventListener('click', () => window.deleteFormMemo(studentId, memo.id));
            container.appendChild(row);
        });
    } catch (e) {
        container.innerHTML = '<p style="color:red;font-size:0.85em;">메모 로드 실패</p>';
    }
}

window.addFormMemo = () => {
    if (!currentStudentId) return;
    window.openMemoModal('form');
};

window.deleteFormMemo = async (studentId, memoId) => {
    if (!confirm('이 메모를 삭제하시겠습니까?')) return;
    try {
        await deleteDoc(doc(db, 'students', studentId, 'memos', memoId));
        // 남은 메모 없으면 has_memo 해제
        const remaining = await getDocs(collection(db, 'students', studentId, 'memos'));
        if (remaining.empty) {
            delete memoCache[studentId];
            await setDoc(doc(db, 'students', studentId), { has_memo: false }, { merge: true });
            const st = allStudents.find(s => s.id === studentId);
            if (st) st.has_memo = false;
            updateListItemIcons(studentId);
        }
        await loadFormMemos(studentId);
    } catch (e) {
        alert('삭제 실패: ' + e.message);
    }
};

// ---------------------------------------------------------------------------
// 탭 전환
// ---------------------------------------------------------------------------
function switchDetailTab(tab) {
    const infoView = document.getElementById('detail-view');
    const histView = document.getElementById('history-view');
    const tabBtns = document.querySelectorAll('.tab-btn');

    tabBtns.forEach(b => b.classList.remove('active'));

    if (tab === 'history') {
        infoView.style.display = 'none';
        histView.style.display = 'block';
        tabBtns[1]?.classList.add('active');
        if (currentStudentId) loadHistory(currentStudentId);
    } else {
        infoView.style.display = 'block';
        histView.style.display = 'none';
        tabBtns[0]?.classList.add('active');
    }
}
window.switchDetailTab = switchDetailTab;

// ---------------------------------------------------------------------------
// 수업 이력 (history_logs)
// ---------------------------------------------------------------------------
async function loadHistory(studentId) {
    const container = document.getElementById('history-list');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-sec);font-size:0.9em;">로딩 중...</p>';

    try {
        const q = query(
            collection(db, 'history_logs'),
            where('doc_id', '==', studentId),
            orderBy('timestamp', 'desc')
        );
        const snap = await getDocs(q);
        const logs = [];
        snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
        renderHistory(logs);
    } catch (e) {
        console.error('[HISTORY ERROR]', e);
        // Firestore 복합 인덱스 미생성 시 에러 메시지에 생성 링크가 포함됨
        const indexUrl = e.message?.match(/https:\/\/console\.firebase\.google\.com\/[^\s]+/)?.[0];
        const safeIndexUrl = indexUrl && /^https:\/\/console\.firebase\.google\.com\//.test(indexUrl) ? indexUrl : null;
        const indexHint = safeIndexUrl
            ? `<br><a href="${esc(safeIndexUrl)}" target="_blank" rel="noopener" style="color:var(--primary);font-size:0.85em;">→ Firebase Console에서 인덱스 생성하기</a>`
            : '';
        container.innerHTML = `<p style="color:red;font-size:0.9em;">이력 로드 실패: ${esc(e.message)}${indexHint}</p>`;
    }
}

function renderHistory(logs) {
    const container = document.getElementById('history-list');
    if (!container) return;
    container.innerHTML = '';

    if (logs.length === 0) {
        container.innerHTML = '<p style="color:var(--text-sec);font-size:0.9em;padding:8px 0;">수업 이력이 없습니다.</p>';
        return;
    }

    const typeLabels = { ENROLL: '등록', UPDATE: '수정', WITHDRAW: '퇴원' };
    const typeClasses = { ENROLL: 'badge-enroll', UPDATE: 'badge-update', WITHDRAW: 'badge-withdraw' };

    logs.forEach(log => {
        const ts = log.timestamp?.toDate ? log.timestamp.toDate() : null;
        const dateStr = ts
            ? ts.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '—';

        const label = typeLabels[log.change_type] || log.change_type;
        const cls = typeClasses[log.change_type] || '';

        const hasBefore = log.before && log.before !== '—';

        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
            <div class="history-item-header">
                <span class="history-badge ${cls}">${esc(label)}</span>
                <span class="history-date">${esc(dateStr)}</span>
                <span class="history-author">${esc(log.google_login_id || '')}</span>
            </div>
            ${hasBefore ? `<div class="history-row history-before"><span class="history-field-label">이전</span><span>${esc(log.before)}</span></div>` : ''}
            <div class="history-row history-after"><span class="history-field-label">내용</span><span>${esc(log.after || '—')}</span></div>
        `;
        container.appendChild(item);
    });
}

// ---------------------------------------------------------------------------
// 일괄처리 (Bulk Actions)
// ---------------------------------------------------------------------------
window.toggleBulkMode = () => {
    if (bulkMode) window.exitBulkMode();
    else enterBulkMode();
};

function showBulkEditPanel() {
    // 우측 패널: 기존 뷰 숨기고 벌크 편집 뷰 표시
    document.getElementById('detail-header').style.display = 'none';
    document.getElementById('detail-tab-bar').style.display = 'none';
    document.getElementById('detail-view').style.display = 'none';
    document.getElementById('history-view').style.display = 'none';
    document.getElementById('detail-form').style.display = 'none';
    document.getElementById('form-header').style.display = 'none';
    document.getElementById('bulk-edit-view').style.display = 'flex';
    updateBulkEditSummary();
}

function hideBulkEditPanel() {
    document.getElementById('bulk-edit-view').style.display = 'none';
    document.getElementById('detail-header').style.display = 'flex';
    document.getElementById('detail-tab-bar').style.display = 'flex';
    document.getElementById('detail-view').style.display = 'block';
    // 입력 필드 초기화
    const statusSel = document.getElementById('bulk-status-select-panel');
    if (statusSel) statusSel.value = '';
    const classCodeEl = document.getElementById('bulk-class-code');
    if (classCodeEl) classCodeEl.value = '';
    document.querySelectorAll('#bulk-day-checkboxes input').forEach(cb => cb.checked = false);
}

function updateBulkEditSummary() {
    const el = document.getElementById('bulk-edit-summary');
    const titleEl = document.getElementById('bulk-edit-title');
    if (!el) return;
    const count = selectedStudentIds.size;
    if (titleEl) titleEl.textContent = `일괄 변경 (${count}명)`;
    if (count === 0) {
        el.innerHTML = '목록에서 학생을 선택하세요';
        return;
    }
    const names = [...selectedStudentIds].slice(0, 5).map(id => {
        const s = allStudents.find(s => s.id === id);
        return s?.name || id;
    });
    const more = count > 5 ? ` 외 ${count - 5}명` : '';
    el.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">group</span>${esc(names.join(', '))}${more}`;
}

function enterBulkMode() {
    bulkMode = true;
    document.getElementById('bulk-action-bar').style.display = 'flex';
    const btn = document.getElementById('bulk-mode-btn');
    if (btn) { btn.classList.add('active'); }
    document.querySelectorAll('.list-item').forEach(el => el.classList.add('bulk-mode'));
    showBulkEditPanel();
    updateBulkBar();
}

function updateBulkBar() {
    const count = selectedStudentIds.size;
    const countEl = document.getElementById('bulk-selected-count');
    const selectAllCb = document.getElementById('bulk-select-all-cb');
    if (countEl) countEl.textContent = `${count}명 선택`;

    // 현재 보이는 학생 목록 기준으로 전체선택 상태 판단
    const visibleCheckboxes = document.querySelectorAll('.list-item-checkbox');
    const allChecked = visibleCheckboxes.length > 0 && [...visibleCheckboxes].every(cb => cb.checked);
    if (selectAllCb) selectAllCb.checked = allChecked;

    if (count > 0 && !bulkMode) enterBulkMode();
    updateBulkEditSummary();
}

window.toggleSelectAll = (checked) => {
    if (!bulkMode) enterBulkMode();
    document.querySelectorAll('.list-item-checkbox').forEach(cb => {
        cb.checked = checked;
        const item = cb.closest('.list-item');
        const id = item?.dataset.id;
        if (id) {
            if (checked) {
                selectedStudentIds.add(id);
                item.classList.add('bulk-selected');
            } else {
                selectedStudentIds.delete(id);
                item.classList.remove('bulk-selected');
            }
        }
    });
    updateBulkBar();
};

window.exitBulkMode = () => {
    bulkMode = false;
    selectedStudentIds.clear();
    document.getElementById('bulk-action-bar').style.display = 'none';
    const btn = document.getElementById('bulk-mode-btn');
    if (btn) btn.classList.remove('active');
    document.querySelectorAll('.list-item').forEach(el => {
        el.classList.remove('bulk-mode', 'bulk-selected');
    });
    document.querySelectorAll('.list-item-checkbox').forEach(cb => cb.checked = false);
    const selectAllCb = document.getElementById('bulk-select-all-cb');
    if (selectAllCb) selectAllCb.checked = false;
    hideBulkEditPanel();
};

// ---------------------------------------------------------------------------
// 일괄 상태 변경 (우측 패널)
// ---------------------------------------------------------------------------
window.applyBulkStatus = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const newStatus = document.getElementById('bulk-status-select-panel').value;
    if (!newStatus) { alert('변경할 상태를 선택해주세요.'); return; }
    if (selectedStudentIds.size === 0) { alert('학생을 선택해주세요.'); return; }

    if (!confirm(`선택한 ${selectedStudentIds.size}명의 상태를 '${newStatus}'(으)로 변경합니다.`)) return;

    const ids = [...selectedStudentIds];
    try {
        const changes = [];

        ids.forEach(id => {
            const student = allStudents.find(s => s.id === id);
            if (!student) return;
            const oldStatus = student.status || '—';
            if (oldStatus === newStatus) return;
            changes.push({ id, name: student.name, from: oldStatus, to: newStatus });
        });

        if (changes.length === 0) { alert('변경할 학생이 없습니다. (이미 같은 상태)'); return; }

        const BATCH_SIZE = 200;
        for (let i = 0; i < changes.length; i += BATCH_SIZE) {
            const chunk = changes.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(c => {
                batch.update(doc(db, 'students', c.id), { status: newStatus });
                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: c.id, change_type: 'UPDATE',
                    before: `상태: ${c.from}`, after: `상태: ${c.to} (일괄변경)`,
                    google_login_id: currentUser?.email || '—', timestamp: serverTimestamp()
                });
            });
            await batch.commit();
        }

        changes.forEach(c => { const s = allStudents.find(s => s.id === c.id); if (s) s.status = newStatus; });
        document.getElementById('bulk-status-select-panel').value = '';
        applyFilterAndRender();
        updateBulkEditSummary();
        alert(`${changes.length}명의 상태를 '${newStatus}'(으)로 변경했습니다.`);
    } catch (e) {
        console.error('[BULK STATUS ERROR]', e);
        alert('일괄 상태 변경 실패: ' + e.message);
    }
};

// ---------------------------------------------------------------------------
// 일괄 반 변경 (우측 패널)
// ---------------------------------------------------------------------------
window.applyBulkClass = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const raw = document.getElementById('bulk-class-code').value.trim().toUpperCase();
    if (!raw) { alert('반코드를 입력해주세요. (예: HX103)'); return; }
    if (selectedStudentIds.size === 0) { alert('학생을 선택해주세요.'); return; }

    // 반코드에서 레벨기호(영문)와 반넘버(숫자) 자동 분리
    const match = raw.match(/^([A-Za-z]+)(\d+)$/);
    if (!match) { alert('반코드 형식이 올바르지 않습니다. (예: HX103, HA201)'); return; }
    const levelSymbol = match[1];
    const classNumber = match[2];

    if (!confirm(`선택한 ${selectedStudentIds.size}명의 반을 '${raw}'(으)로 변경합니다.`)) return;

    const ids = [...selectedStudentIds];
    try {
        const changes = [];
        const updateMap = {}; // id → updateData for local sync

        ids.forEach(id => {
            const student = allStudents.find(s => s.id === id);
            if (!student || !student.enrollments?.length) return;
            const sem = activeFilters.semester;
            const eIdx = sem ? student.enrollments.findIndex(e => e.semester === sem) : 0;
            if (eIdx < 0) return; // 해당 학기 enrollment 없음
            const oldCode = enrollmentCode(student.enrollments[eIdx]);
            const updated = [...student.enrollments];
            updated[eIdx] = { ...updated[eIdx], level_symbol: levelSymbol, class_number: classNumber };

            const newBranch = branchFromClassNumber(classNumber);
            const updateData = { enrollments: updated };
            if (newBranch) updateData.branch = newBranch;

            updateMap[id] = updateData;
            changes.push({ id, name: student.name, from: oldCode, to: raw, eIdx });
        });

        if (changes.length === 0) { alert('변경할 학생이 없습니다.'); return; }

        const BATCH_SIZE = 200;
        for (let i = 0; i < changes.length; i += BATCH_SIZE) {
            const chunk = changes.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(c => {
                batch.update(doc(db, 'students', c.id), updateMap[c.id]);
                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: c.id, change_type: 'UPDATE',
                    before: `반: ${c.from}`, after: `반: ${c.to} (일괄변경)`,
                    google_login_id: currentUser?.email || '—', timestamp: serverTimestamp()
                });
            });
            await batch.commit();
        }

        changes.forEach(c => {
            const s = allStudents.find(s => s.id === c.id);
            if (s && s.enrollments?.[c.eIdx]) {
                s.enrollments[c.eIdx].level_symbol = levelSymbol;
                s.enrollments[c.eIdx].class_number = classNumber;
                const newBranch = branchFromClassNumber(classNumber);
                if (newBranch) s.branch = newBranch;
            }
        });

        document.getElementById('bulk-class-code').value = '';
        buildClassFilterSidebar();
        applyFilterAndRender();
        updateBulkEditSummary();
        const semLabel = activeFilters.semester || '첫 번째';
        alert(`${changes.length}명의 반을 '${raw}'(으)로 변경했습니다. (${semLabel} 수업)`);
    } catch (e) {
        console.error('[BULK CLASS ERROR]', e);
        alert('일괄 반 변경 실패: ' + e.message);
    }
};

// ---------------------------------------------------------------------------
// 일괄 등원요일 변경 (우측 패널)
// ---------------------------------------------------------------------------
window.applyBulkDays = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const checked = [...document.querySelectorAll('#bulk-day-checkboxes input:checked')].map(cb => cb.value);
    if (checked.length === 0) { alert('변경할 요일을 선택해주세요.'); return; }
    if (selectedStudentIds.size === 0) { alert('학생을 선택해주세요.'); return; }

    if (!confirm(`선택한 ${selectedStudentIds.size}명의 등원요일을 '${checked.join(', ')}'(으)로 변경합니다.`)) return;

    const ids = [...selectedStudentIds];
    try {
        const changes = [];
        const updateMap = {}; // id → updateData for batching

        ids.forEach(id => {
            const student = allStudents.find(s => s.id === id);
            if (!student || !student.enrollments?.length) return;
            const sem = activeFilters.semester;
            const eIdx = sem ? student.enrollments.findIndex(e => e.semester === sem) : 0;
            if (eIdx < 0) return;
            const oldDays = displayDays(student.enrollments[eIdx].day);
            const updated = [...student.enrollments];
            updated[eIdx] = { ...updated[eIdx], day: [...checked] };
            updateMap[id] = { enrollments: updated };
            changes.push({ id, name: student.name, from: oldDays, to: checked.join(', '), eIdx });
        });

        if (changes.length === 0) { alert('변경할 학생이 없습니다.'); return; }

        const BATCH_SIZE = 200;
        for (let i = 0; i < changes.length; i += BATCH_SIZE) {
            const chunk = changes.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(c => {
                batch.update(doc(db, 'students', c.id), updateMap[c.id]);
                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: c.id, change_type: 'UPDATE',
                    before: `요일: ${c.from}`, after: `요일: ${c.to} (일괄변경)`,
                    google_login_id: currentUser?.email || '—', timestamp: serverTimestamp()
                });
            });
            await batch.commit();
        }

        // 로컬 데이터 업데이트
        changes.forEach(c => {
            const s = allStudents.find(s => s.id === c.id);
            if (s && s.enrollments?.[c.eIdx]) {
                s.enrollments[c.eIdx].day = [...checked];
            }
        });

        document.querySelectorAll('#bulk-day-checkboxes input').forEach(cb => cb.checked = false);
        applyFilterAndRender();
        updateBulkEditSummary();
        const semLabel = activeFilters.semester || '첫 번째';
        alert(`${changes.length}명의 등원요일을 변경했습니다. (${semLabel} 수업)`);
    } catch (e) {
        console.error('[BULK DAYS ERROR]', e);
        alert('일괄 요일 변경 실패: ' + e.message);
    }
};

// ---------------------------------------------------------------------------
// 일괄 편집 초기화 버튼
// ---------------------------------------------------------------------------
window.resetBulkStatus = () => {
    const sel = document.getElementById('bulk-status-select-panel');
    if (sel) sel.value = '';
};
window.resetBulkClass = () => {
    const el = document.getElementById('bulk-class-code');
    if (el) el.value = '';
};
window.resetBulkDays = () => {
    document.querySelectorAll('#bulk-day-checkboxes input').forEach(cb => cb.checked = false);
};

// ---------------------------------------------------------------------------
// 일괄 학년 승격 (우측 패널)
// ---------------------------------------------------------------------------
window.applyBulkPromotion = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    if (selectedStudentIds.size === 0) { alert('학생을 선택해주세요.'); return; }
    const newSchool = document.getElementById('bulk-promote-school').value.trim();

    // 승격 규칙: 초등 max 6학년, 중등 max 3학년, 고등 max 3학년
    const MAX_GRADE = { '초등': 6, '중등': 3, '고등': 3 };
    const NEXT_LEVEL = { '초등': '중등', '중등': '고등' };

    const ids = [...selectedStudentIds];
    const changes = [];
    const skipped = [];

    ids.forEach(id => {
        const student = allStudents.find(s => s.id === id);
        if (!student) return;
        const oldLevel = student.level || '';
        const oldGrade = parseInt(student.grade, 10) || 0;
        const oldSchool = student.school || '';
        if (!oldLevel || !oldGrade) { skipped.push(`${student.name} (학부/학년 정보 없음)`); return; }

        const maxG = MAX_GRADE[oldLevel] || 6;
        let afterLevel = oldLevel;
        let afterGrade = oldGrade + 1;
        let afterSchool = oldSchool;
        let isTransition = false;

        if (oldGrade >= maxG) {
            // 학부 전환 (초6→중1, 중3→고1)
            const next = NEXT_LEVEL[oldLevel];
            if (!next) { skipped.push(`${student.name} (고${oldGrade} — 졸업 대상)`); return; }
            afterLevel = next;
            afterGrade = 1;
            isTransition = true;
            afterSchool = newSchool || '';  // 전환 시 학교 비우면 빈칸으로 초기화
        }

        const beforeParts = [oldLevel, `${oldGrade}학년`, oldSchool].filter(Boolean).join(' ');
        const afterParts = [afterLevel, `${afterGrade}학년`, afterSchool].filter(Boolean).join(' ');

        const updateData = { grade: afterGrade };
        if (afterLevel !== oldLevel) updateData.level = afterLevel;
        if (afterSchool !== oldSchool) updateData.school = afterSchool;

        changes.push({ id, name: student.name, before: beforeParts, after: afterParts, updateData, afterLevel, afterGrade, afterSchool, isTransition });
    });

    if (changes.length === 0) { alert('승격할 학생이 없습니다.' + (skipped.length ? `\n\n건너뜀:\n${skipped.join('\n')}` : '')); return; }

    // 확인 메시지 구성
    const normal = changes.filter(c => !c.isTransition);
    const transition = changes.filter(c => c.isTransition);
    let desc = `총 ${changes.length}명 학년 +1 승격`;
    if (normal.length) desc += `\n• 일반 승격: ${normal.length}명`;
    if (transition.length) desc += `\n• 학부 전환: ${transition.length}명 (${transition.map(c => `${c.name}: ${c.before} → ${c.after}`).join(', ')})`;
    if (skipped.length) desc += `\n\n건너뜀 ${skipped.length}명:\n${skipped.join('\n')}`;
    if (!confirm(desc)) return;

    try {
        const BATCH_SIZE = 200;
        for (let i = 0; i < changes.length; i += BATCH_SIZE) {
            const chunk = changes.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(c => {
                batch.update(doc(db, 'students', c.id), c.updateData);
                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: c.id, change_type: 'UPDATE',
                    before: c.before, after: `${c.after} (일괄승격)`,
                    google_login_id: currentUser?.email || '—', timestamp: serverTimestamp()
                });
            });
            await batch.commit();
        }

        // 로컬 데이터 업데이트
        changes.forEach(c => {
            const s = allStudents.find(s => s.id === c.id);
            if (s) {
                s.grade = c.afterGrade;
                if (c.afterLevel !== s.level) s.level = c.afterLevel;
                if (c.afterSchool !== s.school) s.school = c.afterSchool;
            }
        });

        document.getElementById('bulk-promote-school').value = '';
        applyFilterAndRender();
        updateBulkEditSummary();
        alert(`${changes.length}명의 학년을 승격했습니다.` + (skipped.length ? `\n건너뜀: ${skipped.length}명` : ''));
    } catch (e) {
        console.error('[BULK PROMOTION ERROR]', e);
        alert('일괄 학년 승격 실패: ' + e.message);
    }
};

window.resetBulkPromotion = () => {
    document.getElementById('bulk-promote-school').value = '';
};

// ---------------------------------------------------------------------------
// 일괄 삭제
// ---------------------------------------------------------------------------
window.bulkDelete = () => {
    if (selectedStudentIds.size === 0) { alert('학생을 선택해주세요.'); return; }
    const ids = [...selectedStudentIds];
    const desc = document.getElementById('bulk-delete-desc');
    if (desc) desc.innerHTML = `선택한 <strong>${ids.length}명</strong>의 학생을 삭제합니다.<br><span style="color:#c5221f;font-size:13px;">이 작업은 되돌릴 수 없습니다.</span>`;

    const listEl = document.getElementById('bulk-delete-list');
    if (listEl) {
        listEl.innerHTML = ids.map(id => {
            const s = allStudents.find(s => s.id === id);
            return `<div class="bulk-delete-item"><span>${esc(s?.name || id)}</span><span style="font-size:12px;color:var(--text-sec);">${esc(allClassCodes(s || {}).join(', ') || '—')}</span></div>`;
        }).join('');
    }
    document.getElementById('bulk-delete-modal').style.display = 'flex';
};

window.closeBulkDeleteModal = (e) => {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('bulk-delete-modal').style.display = 'none';
};

window.confirmBulkDelete = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const ids = [...selectedStudentIds];
    const confirmBtn = document.querySelector('#bulk-delete-modal .btn-end-class-confirm');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '퇴원 처리 중...'; }

    try {
        // 퇴원 처리 전에 학생 이름을 미리 수집
        const idNameMap = {};
        ids.forEach(id => {
            const s = allStudents.find(s => s.id === id);
            idNameMap[id] = s?.name || id;
        });

        const BATCH_SIZE = 200;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const chunk = ids.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(id => {
                batch.set(doc(db, 'students', id), { status: '퇴원' }, { merge: true });
                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: id, change_type: 'WITHDRAW',
                    before: `학생: ${idNameMap[id]}`, after: '일괄 퇴원 처리',
                    google_login_id: currentUser?.email || '—', timestamp: serverTimestamp()
                });
            });
            await batch.commit();
        }

        allStudents.forEach(s => { if (selectedStudentIds.has(s.id)) s.status = '퇴원'; });
        window.closeBulkDeleteModal();
        window.exitBulkMode();
        buildClassFilterSidebar();
        applyFilterAndRender();
        currentStudentId = null;
        alert(`${ids.length}명의 학생이 퇴원 처리되었습니다.`);
    } catch (e) {
        console.error('[BULK DELETE ERROR]', e);
        alert('일괄 퇴원 처리 실패: ' + e.message);
    } finally {
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '퇴원'; }
    }
};

// ---------------------------------------------------------------------------
// 일별 통계 뷰어 (Daily Stats Viewer)
// ---------------------------------------------------------------------------
window.showDailyStats = async () => {
    if (currentUserRole !== 'admin') return;
    const statsView = document.getElementById('daily-stats-view');
    const listPanel = document.querySelector('.list-panel');
    if (!statsView || !listPanel) return;

    // 목록 패널 내용을 통계 뷰로 교체
    statsView.style.display = 'block';
    listPanel.querySelector('.panel-header').style.display = 'none';
    const bulkBar = document.getElementById('bulk-action-bar');
    if (bulkBar) bulkBar.style.display = 'none';
    listPanel.querySelector('.list-items').style.display = 'none';

    // 오늘 날짜로 로드
    const dateInput = document.getElementById('stats-date-input');
    dateInput.value = getTodayDateStr();
    await loadStatsForDate(getTodayDateStr());
};

window.hideDailyStats = () => {
    const statsView = document.getElementById('daily-stats-view');
    const listPanel = document.querySelector('.list-panel');
    if (!statsView || !listPanel) return;

    statsView.style.display = 'none';
    listPanel.querySelector('.panel-header').style.display = '';
    listPanel.querySelector('.list-items').style.display = '';
};

window.onStatsDateChange = async (dateStr) => {
    if (dateStr) await loadStatsForDate(dateStr);
};

async function loadStatsForDate(dateStr) {
    const container = document.getElementById('stats-content');
    if (!container) return;
    container.innerHTML = '<p style="padding:16px;color:var(--text-sec)">로딩 중...</p>';

    try {
        const statsRef = doc(db, 'daily_stats', dateStr);
        const snap = await getDoc(statsRef);

        if (!snap.exists()) {
            container.innerHTML = `<p style="padding:24px;color:var(--text-sec);text-align:center;">
                <span class="material-symbols-outlined" style="font-size:48px;display:block;margin-bottom:8px;color:#dadce0;">event_busy</span>
                ${esc(dateStr)}의 통계 데이터가 없습니다.<br>
                <small>해당일에 로그인한 기록이 없거나 아직 생성되지 않았습니다.</small>
            </p>`;
            return;
        }

        const data = snap.data();
        renderStatsView(data, container);
    } catch (e) {
        console.error('[DAILY STATS] Load error:', e);
        container.innerHTML = '<p style="padding:16px;color:red">통계 로드 실패</p>';
    }
}

function renderStatsView(data, container) {
    const genAt = data.generated_at?.toDate?.() || null;
    const genStr = genAt ? `${genAt.getFullYear()}-${String(genAt.getMonth()+1).padStart(2,'0')}-${String(genAt.getDate()).padStart(2,'0')} ${String(genAt.getHours()).padStart(2,'0')}:${String(genAt.getMinutes()).padStart(2,'0')}` : '—';

    const bs = data.by_status || {};
    const bsb = data.by_status_branch || {};
    // 현인원 = 재원 + 실휴원 + 가휴원
    const activeCount = (src) => (src['재원'] || 0) + (src['실휴원'] || 0) + (src['가휴원'] || 0);
    // 표 행 순서: 현인원(합계), 실인원(=재원), 실휴원, 가휴원, 등원예정, 퇴원
    const dataRows = [
        { label: '실인원', key: '재원' },
        { label: '실휴원', key: '실휴원' },
        { label: '가휴원', key: '가휴원' },
        { label: '등원예정', key: '등원예정' },
        { label: '퇴원', key: '퇴원' },
    ];

    // ── 상태별 × 단지별 테이블 ──
    let html = `
        <div class="stats-meta">
            <span>생성: ${esc(genStr)}</span>
            <span>작성자: ${esc(data.generated_by || '—')}</span>
        </div>

        <div class="stats-section">
            <h4 class="stats-section-title">
                <span class="material-symbols-outlined">groups</span>인원 현황
            </h4>
            <table class="stats-table">
                <thead>
                    <tr>
                        <th></th>
                        <th>전체</th>
                        <th>2단지</th>
                        <th>10단지</th>
                    </tr>
                </thead>
                <tbody>`;

    // 현인원 (재원 + 실휴원 + 가휴원) — 하이라이트
    html += `<tr class="stats-table-highlight">
        <td class="stats-table-label">현인원</td>
        <td><strong>${activeCount(bs)}</strong></td>
        <td><strong>${activeCount(bsb['2단지'] || {})}</strong></td>
        <td><strong>${activeCount(bsb['10단지'] || {})}</strong></td>
    </tr>`;

    // 실인원(=재원), 실휴원, 가휴원, 등원예정, 퇴원
    dataRows.forEach(({ label, key }) => {
        html += `<tr>
            <td class="stats-table-label">${esc(label)}</td>
            <td>${bs[key] || 0}</td>
            <td>${bsb['2단지']?.[key] || 0}</td>
            <td>${bsb['10단지']?.[key] || 0}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;

    // ── 인원 현황 그래프 (stacked bar: 2단지 + 10단지) ──
    const chartRows = [
        { label: '현인원', val: activeCount(bs), v2: activeCount(bsb['2단지'] || {}), v10: activeCount(bsb['10단지'] || {}) },
        ...dataRows.map(({ label, key }) => ({
            label,
            val: bs[key] || 0,
            v2: bsb['2단지']?.[key] || 0,
            v10: bsb['10단지']?.[key] || 0,
        }))
    ];
    const chartMax = Math.max(...chartRows.map(r => r.val), 1);

    html += `
    <div class="stats-section">
        <h4 class="stats-section-title">
            <span class="material-symbols-outlined">bar_chart</span>인원 현황 그래프
            <span class="stats-legend">
                <span class="stats-legend-dot" style="background:#4285f4"></span>2단지
                <span class="stats-legend-dot" style="background:#fbbc04"></span>10단지
            </span>
        </h4>
        <div class="stats-bar-list">`;

    chartRows.forEach((r, i) => {
        const pct2 = (r.v2 / chartMax) * 100;
        const pct10 = (r.v10 / chartMax) * 100;
        const isHighlight = i === 0;
        html += `
        <div class="stats-bar-item${isHighlight ? ' stats-bar-highlight' : ''}">
            <span class="stats-bar-label">${esc(r.label)}</span>
            <div class="stats-bar-track">
                <div class="stats-bar-fill stats-bar-stack" style="width:${pct2}%;background:#4285f4"></div><div class="stats-bar-fill stats-bar-stack" style="width:${pct10}%;background:#fbbc04"></div>
            </div>
            <span class="stats-bar-value">${r.v2}+${r.v10}=${r.val}</span>
        </div>`;
    });

    html += `</div></div>`;

    // ── 레벨기호별 (stacked bar: 2단지 + 10단지) ──
    const lsb = data.by_level_symbol_branch || {};
    const lsKeys = Object.keys(lsb);
    if (lsKeys.length) {
        // 학부 순서 매핑: 초등=0, 중등=1, 고등=2
        const levelOrder = { '초등': 0, '중등': 1, '고등': 2 };
        const sorted = lsKeys.sort((a, b) => {
            const la = levelOrder[lsb[a]?.level] ?? 9;
            const lb = levelOrder[lsb[b]?.level] ?? 9;
            if (la !== lb) return la - lb;
            return a.localeCompare(b);
        });

        // 최대값 계산 (바 비율용)
        let maxTotal = 0;
        sorted.forEach(ls => {
            const t = (lsb[ls]['2단지'] || 0) + (lsb[ls]['10단지'] || 0);
            if (t > maxTotal) maxTotal = t;
        });

        let currentLevel = '';
        html += `
        <div class="stats-section">
            <h4 class="stats-section-title">
                <span class="material-symbols-outlined">class</span>레벨기호별
                <span class="stats-legend">
                    <span class="stats-legend-dot" style="background:#4285f4"></span>2단지
                    <span class="stats-legend-dot" style="background:#fbbc04"></span>10단지
                </span>
            </h4>
            <div class="stats-bar-list">`;

        sorted.forEach(ls => {
            const info = lsb[ls];
            const lv = info.level || '';
            const cnt2 = info['2단지'] || 0;
            const cnt10 = info['10단지'] || 0;
            const total = cnt2 + cnt10;
            const pct2 = maxTotal ? (cnt2 / maxTotal) * 100 : 0;
            const pct10 = maxTotal ? (cnt10 / maxTotal) * 100 : 0;

            // 학부 구분선
            if (lv && lv !== currentLevel) {
                currentLevel = lv;
                html += `<div class="stats-bar-divider">${esc(lv)}</div>`;
            }

            html += `
            <div class="stats-bar-item">
                <span class="stats-bar-label">${esc(ls)}</span>
                <div class="stats-bar-track">
                    <div class="stats-bar-fill stats-bar-stack" style="width:${pct2}%;background:#4285f4"></div><div class="stats-bar-fill stats-bar-stack" style="width:${pct10}%;background:#fbbc04"></div>
                </div>
                <span class="stats-bar-value">${cnt2}+${cnt10}=${total}</span>
            </div>`;
        });

        html += `</div></div>`;
    }

    container.innerHTML = html;
}

// ---------------------------------------------------------------------------
// 패널 리사이저 (드래그로 목록/상세 크기 조절)
// ---------------------------------------------------------------------------
(() => {
    const resizer = document.getElementById('panel-resizer');
    const detailPanel = document.querySelector('.detail-panel');
    if (!resizer || !detailPanel) return;

    let startX, startWidth;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startWidth = detailPanel.offsetWidth;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (e) => {
            const diff = startX - e.clientX;
            const newWidth = Math.max(280, Math.min(800, startWidth + diff));
            detailPanel.style.width = newWidth + 'px';
        };

        const onMouseUp = () => {
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
})();

