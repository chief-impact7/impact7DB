// 내신 csKey 이전 Phase 0 stale audit — READ ONLY. students write 없음.
// (a) 전체 students, (b) 활성 내신 대상에서 .school != currentSchool 또는 school_* 누락 집계.
import admin from 'firebase-admin';
import { currentSchool, SCHOOL_FIELD } from '@impact7/shared/student-label';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname, '..', 'service-account.json'), 'utf8'))),
  projectId: 'impact7db',
});
const db = admin.firestore();

const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고' };
const NAESIN_OVERRIDE_EXCLUDE = '';

// student-helpers.js 미러 (school 소스만 currentSchool로 교체한 "이전 후" 키, 그리고 .school 기반 "이전 전" 키 둘 다 계산)
function branchFromStudent(s) {
  if (s.branch) return s.branch;
  const regular = (s.enrollments || []).find(e => e.class_type === '정규' || e.class_type === '자유학기');
  const cn = regular?.class_number || '';
  const first = (cn.trim()[0]);
  if (first === '1') return '2단지';
  if (first === '2') return '10단지';
  return '';
}
function deriveGroup(student, enrollment) {
  const cn = enrollment.class_number || '';
  const lastChar = cn.slice(-1).toUpperCase();
  let group = '';
  if (lastChar === 'A' || lastChar === 'B') group = lastChar;
  else { const d = parseInt(lastChar); if (!isNaN(d)) group = d % 2 === 1 ? 'A' : 'B'; }
  if (!group) {
    const reg = (student.enrollments || []).find(e => (e.class_type === '정규' || e.class_type === '자유학기') && e.class_number);
    if (reg) { const r = parseInt((reg.class_number || '').slice(-1)); if (!isNaN(r)) group = r % 2 === 1 ? 'A' : 'B'; }
  }
  return group;
}
function deriveCodeWithSchool(student, enrollment, school) {
  const levelShort = LEVEL_SHORT[student.level] || '';
  const grade = student.grade || '';
  if (!school || !grade) return '';
  const group = deriveGroup(student, enrollment);
  return `${school}${levelShort}${grade}${group}`;
}
// regularEnroll 선정: 정규/자유학기 + class_number
function regularEnrollOf(s) {
  return (s.enrollments || []).find(e => (e.class_type === '정규' || e.class_type === '자유학기') && e.class_number)
      || (s.enrollments || []).find(e => (e.class_type === '정규' || e.class_type === '자유학기'));
}
// csKey 둘 다: school 소스만 다름
function csKeyWith(student, school) {
  const reg = regularEnrollOf(student);
  if (!reg) return null;
  const override = reg.naesin_class_override;
  if (typeof override === 'string') return override === NAESIN_OVERRIDE_EXCLUDE ? null : override; // override는 school 무관
  const code = deriveCodeWithSchool(student, reg, school);
  if (!code) return null;
  return branchFromStudent(student) + code;
}

const ACTIVE_STATUS = new Set(['재원', '등원예정']); // 내신 게이트: 재원 계열만
const LEAVE = new Set(['가휴원', '실휴원']);

const snap = await db.collection('students').get();

let total = 0;
const allStale = [];      // 전체 students 중 stale (활성 무관)
const activeNaesin = [];  // 활성 내신 대상
const activeStale = [];   // 활성 내신 대상 중 stale
const causes = { '미러stale(진급의심)': 0, '졸업/예측': 0, 'school_누락': 0, '기타불일치': 0 };
const overrideStaleButKept = []; // override 보유라 키 보존되지만 .school!=currentSchool인 활성 내신

snap.forEach(d => {
  const x = d.data();
  total++;
  const level = x.level;
  const field = SCHOOL_FIELD[level];
  const cs = currentSchool(x);              // 현재 학부 학교명 (raw)
  const dotSchool = x.school || '';
  const fieldMissing = !!field && !x[field]; // 현재 학부 school_* 누락
  const mismatch = dotSchool !== cs;         // 미러 불일치

  const isStale = mismatch || fieldMissing;

  // (b) 활성 내신 대상 판정
  const reg = regularEnrollOf(x);
  const hasNaesinEnroll = (x.enrollments || []).some(e => e.class_type === '내신');
  const override = reg?.naesin_class_override;
  const hasOverride = typeof override === 'string' && override !== NAESIN_OVERRIDE_EXCLUDE;
  const isExcluded = typeof override === 'string' && override === NAESIN_OVERRIDE_EXCLUDE;
  // 자동유도 키가 나오는지(=내신 대상): override가 키이거나, 정규enroll로 deriveCode 가능
  const autoKeyable = !!reg && !isExcluded && !!deriveCodeWithSchool(x, reg, cs);
  const naesinTarget = ACTIVE_STATUS.has(x.status) && (hasOverride || autoKeyable || hasNaesinEnroll);

  if (isStale) {
    allStale.push({ id: d.id, name: x.name, level, status: x.status, school: dotSchool, currentSchool: cs, fieldMissing });
  }
  if (naesinTarget) {
    activeNaesin.push(d.id);
    if (isStale) {
      // override 보유면 csKey는 문자열 그대로 보존 → 키 영향 없음. 그래도 분류는 한다.
      const oldKey = csKeyWith(x, dotSchool);
      const newKey = csKeyWith(x, cs);
      const keyChanges = oldKey !== newKey;
      const rec = { id: d.id, name: x.name, level, status: x.status, school: dotSchool, currentSchool: cs, fieldMissing, hasOverride, oldKey, newKey, keyChanges };
      if (hasOverride && !keyChanges) overrideStaleButKept.push(rec);
      else activeStale.push(rec);

      // 원인 분류
      if (fieldMissing) causes['school_누락']++;
      else if ((x.school_level_grade || '').includes('졸업')) causes['졸업/예측']++;
      else if (mismatch && x[field]) causes['미러stale(진급의심)']++;
      else causes['기타불일치']++;
    }
  }
});

console.log('===== 내신 csKey stale audit (READ ONLY) =====');
console.log(`전체 students: ${total}`);
console.log(`전체 stale(.school!=currentSchool 또는 school_* 누락): ${allStale.length}`);
console.log(`활성 내신 대상(status 재원/등원예정 + 내신 키 가능): ${activeNaesin.length}`);
console.log(`활성 내신 stale (키 실제 변동 위험): ${activeStale.length}`);
console.log(`활성 내신 stale 이지만 override로 키 보존: ${overrideStaleButKept.length}`);
console.log('\n--- 활성 내신 stale 원인 분류 ---');
console.log(JSON.stringify(causes, null, 2));

console.log('\n--- 활성 내신 stale 샘플 (최대 20, keyChanges=실제 키 변동) ---');
activeStale.slice(0, 20).forEach(r =>
  console.log(`  ${r.name||'?'} [${r.level}/${r.status}] school="${r.school}" cur="${r.currentSchool}" miss=${r.fieldMissing} override=${r.hasOverride} keyΔ=${r.keyChanges}\n     old=${r.oldKey} -> new=${r.newKey}`)
);

console.log('\n--- 실제 키 변동 표본 (keyChanges=true, 최대 5) ---');
activeStale.filter(r => r.keyChanges).slice(0, 5).forEach(r =>
  console.log(`  ${r.name||'?'} (${r.id}): "${r.oldKey}" -> "${r.newKey}"`)
);

console.log('\n--- 전체 stale 샘플 (활성 무관, 최대 15) ---');
allStale.slice(0, 15).forEach(r =>
  console.log(`  ${r.name||'?'} [${r.level}/${r.status}] school="${r.school}" cur="${r.currentSchool}" miss=${r.fieldMissing}`)
);

const keyChangeCount = activeStale.filter(r => r.keyChanges).length;
console.log(`\n===== GATE: 활성 내신 실제 키변동 = ${keyChangeCount} / 활성 내신 stale = ${activeStale.length} =====`);
process.exit(0);
