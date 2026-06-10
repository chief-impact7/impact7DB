// 일별 인원현황 스냅샷 (daily_stats/{YYYY-MM-DD}) 서버사이드 생성.
// firestore.rules가 daily_stats read/create를 인원현황 권한자(HR_users canViewPopulationStats)로
// 제한하면서, 클라이언트 자동 생성(app.js generateDailyStatsIfNeeded)은 권한자가 로그인한 날만
// 동작한다 → 스케줄 함수(Admin SDK, rules 무관)로 결손 없이 매일 보장한다.
//
// ⚠️  DRIFT 경고: 집계 로직은 app.js generateDailyStatsIfNeeded()와 1:1 미러.
//     app.js :: branchFromClassNumber() → branchFromClassNumber()
//     app.js :: branchesFromStudent()   → branchesFromStudent()
//     app.js :: enrollmentCode()        → naesinHelpers.enrollmentCode (재사용)
import { FieldValue } from 'firebase-admin/firestore';
import { todayKST } from './kst.js';
import { enrollmentCode } from './naesinHelpers.js';

// 단지 파생. 내신 csKey('2단지…'/'10단지…')는 접두로, 정규 반번호는 첫 숫자('1xx'→2단지, '2xx'→10단지)로.
function branchFromClassNumber(num) {
  const c = (num || '').trim();
  if (c.startsWith('10단지')) return '10단지'; // 반번호 '1xx' 규칙보다 먼저
  if (c.startsWith('2단지')) return '2단지';
  const first = c[0];
  if (first === '1') return '2단지';
  if (first === '2') return '10단지';
  return '';
}

// 학생의 모든 소속 지점 (여러 enrollment에서 파생된 지점 합집합)
function branchesFromStudent(s) {
  const set = new Set();
  (s.enrollments || []).forEach((e) => {
    const b = branchFromClassNumber(e.class_number);
    if (b) set.add(b);
  });
  if (set.size === 0 && s.branch) set.add(s.branch);
  return [...set];
}

export async function generateDailyStats(db, dateStr = todayKST()) {
  const ref = db.collection('daily_stats').doc(dateStr);
  const existing = await ref.get();
  if (existing.exists) return { dateStr, skipped: true };

  const snap = await db.collection('students').get();

  const byStatus = {};
  const byBranch = {};
  const byLevel = {};
  const byClassCode = {};
  const byStatusBranch = {};
  const byLevelSymbolBranch = {};
  let total = 0;
  let activeTotal = 0;

  snap.forEach((doc) => {
    const s = doc.data();
    total++;
    const st = s.status || '재원';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (st !== '퇴원') activeTotal++;

    branchesFromStudent(s).forEach((br) => {
      byBranch[br] = (byBranch[br] || 0) + 1;
      if (!byStatusBranch[br]) byStatusBranch[br] = {};
      byStatusBranch[br][st] = (byStatusBranch[br][st] || 0) + 1;
    });

    const lv = s.level || '';
    if (lv) byLevel[lv] = (byLevel[lv] || 0) + 1;

    (s.enrollments || []).forEach((e) => {
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

  await ref.set({
    date: dateStr,
    generated_at: FieldValue.serverTimestamp(),
    generated_by: 'fn-daily-stats',
    total,
    active_total: activeTotal,
    by_status: byStatus,
    by_branch: byBranch,
    by_level: byLevel,
    by_class_code: byClassCode,
    by_status_branch: byStatusBranch,
    by_level_symbol_branch: byLevelSymbolBranch,
  });
  return { dateStr, total, activeTotal };
}
