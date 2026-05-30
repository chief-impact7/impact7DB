import { currentSchool } from '@impact7/shared/student-label';

// students 미러 .school 제거 후: 현재 학부 학교는 currentSchool(학부별 필드) 우선.
// import 단계 temp 객체는 school_* 가 없으므로 작업용 .school 으로 폴백.
const schoolOf = (s) => currentSchool(s) || s?.school || '';

const LEVEL_SUFFIXES = {
    '초등': [
        { suffix: '초등학교', safe: true },
        { suffix: '초등', safe: true },
        { suffix: '초교', safe: true },
        { suffix: '초', safe: false },
    ],
    '중등': [
        { suffix: '중학교', safe: true },
        { suffix: '중등', safe: true },
        { suffix: '중', safe: false },
    ],
    '고등': [
        { suffix: '고등학교', safe: true },
        { suffix: '고등', safe: true },
        { suffix: '고교', safe: true },
        { suffix: '고', safe: false },
    ],
};

export function cleanSchoolName(school) {
    return String(school || '').trim().replace(/\s+/g, ' ');
}

export function levelShortName(level) {
    if (level === '초등') return '초';
    if (level === '중등') return '중';
    if (level === '고등') return '고';
    return level || '';
}

export function collectKnownSchoolNames(students = []) {
    return new Set(students.map(s => cleanSchoolName(schoolOf(s))).filter(Boolean));
}

export function normalizeStudentSchools(students = [], knownStudents = []) {
    const knownSchools = collectKnownSchoolNames([...knownStudents, ...students]);
    for (const student of students) {
        student.school = normalizeSchoolName(student.school, student.level, knownSchools);
    }
}

export function normalizeSchoolName(school, level, knownSchools = new Set()) {
    const value = cleanSchoolName(school);
    const suffixes = LEVEL_SUFFIXES[level] || [];
    for (const { suffix, safe } of suffixes) {
        if (!value.endsWith(suffix) || value.length <= suffix.length) continue;
        const base = value.slice(0, -suffix.length).trim();
        if (safe || knownSchools.has(base)) return base;
    }
    return value;
}

export { studentSearchTerms as schoolSearchTerms } from '@impact7/shared/student-label';
