import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { todayKST } from '@impact7/shared/datetime';
import { currentSchool } from '@impact7/shared/student-label';
import { generateText } from './vertex.js';
import { writeLog } from './notifyLog.js';

// 종합상태 + 상담요약 + 다음상담 브리핑을 단일 Gemini 호출로 생성하는 통합 핸들러.
// 기존 generateStudentStatusAi(종합) + generateStudentConsultationAi(상담)를 대체.
// 결과는 기존 3개 컬렉션(student_status_summaries / consultation_summaries / consultation_briefings)에
// 분산 저장해 UI는 무변경.

const MODEL = 'gemini-3.1-pro-preview';
const MAX_DAILY_RECORDS = 60;     // 최근 60개 수업 기록
const MAX_CONSULTATIONS = 60;     // 최근 60건 상담
const MONTHS_BACK = 3;
const CONSULT_GAP_DAYS = 30;      // 상담 공백 경고 임계 (일)

function isAuthorizedEmail(email) {
  return /@(gw\.)?impact7\.kr$/i.test(email || '');
}

function textOf(v) {
  return String(v ?? '').trim();
}

function cutoffDateStr() {
  const d = new Date();
  d.setMonth(d.getMonth() - MONTHS_BACK);
  return d.toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' 두 날짜의 일수 차이 (a - b). 비정상 값은 null.
function dayDiff(a, b) {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((ta - tb) / 86400000);
}

// 컬렉션별 인덱스 전략은 daily_records만 서버 range+정렬, 나머지는 equality-only 후 메모리 cutoff.
function afterCutoff(docs, field, cutoff) {
  return docs.map(d => d.data()).filter(r => String(r[field] || '') >= cutoff);
}

async function fetchAllData(firestore, studentId) {
  const cutoff = cutoffDateStr();

  const [studentSnap, dailySnap, absenceSnap, hwSnap, testSnap, consultSnap] = await Promise.all([
    firestore.collection('students').doc(studentId).get(),
    firestore.collection('daily_records')
      .where('student_id', '==', studentId)
      .where('date', '>=', cutoff)
      .orderBy('date', 'desc')
      .limit(MAX_DAILY_RECORDS)
      .get(),
    firestore.collection('absence_records').where('student_id', '==', studentId).get(),
    firestore.collection('hw_fail_tasks').where('student_id', '==', studentId).get(),
    firestore.collection('test_fail_tasks').where('student_id', '==', studentId).get(),
    firestore.collection('consultations')
      .where('student_id', '==', studentId)
      .orderBy('date', 'desc')
      .limit(MAX_CONSULTATIONS)
      .get(),
  ]);

  if (!studentSnap.exists) throw new HttpsError('not-found', '학생을 찾을 수 없습니다.');

  // 최신순으로 받은 상담을 오래된→최신으로 뒤집어 누적요약 맥락을 자연스럽게.
  const consultations = consultSnap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();

  return {
    student: { student_id: studentId, ...studentSnap.data() },
    dailyRecords: dailySnap.docs.map(d => d.data()),
    absenceRecords: afterCutoff(absenceSnap.docs, 'absence_date', cutoff),
    hwFails: afterCutoff(hwSnap.docs, 'source_date', cutoff),
    testFails: afterCutoff(testSnap.docs, 'source_date', cutoff),
    consultations,
  };
}

// hw_fail_tasks/test_fail_tasks의 status는 한국어: 'pending' | '완료' | '취소' | '기타'.
function failTaskSummary(tasks) {
  const pending = tasks.filter(t => t.status === 'pending').length;
  const done = tasks.filter(t => t.status === '완료').length;
  const domains = [...new Set(tasks.map(t => t.domain).filter(Boolean))].join(', ');
  return `총 ${tasks.length}건 (미처리 ${pending}, 완료 ${done}) / 영역: ${domains || '없음'}`;
}

function consultationLine(c) {
  return `${c.date || '-'} [${c.consultation_type || '-'}] ${textOf(c.text).slice(0, 120)}`;
}

function buildPrompt({ student, dailyRecords, absenceRecords, hwFails, testFails, consultations }, gapDays) {
  const profile = {
    name: student.name || '',
    status: student.status || '',
    school: currentSchool(student) || '',
    grade: student.grade || '',
    branch: student.branch || '',
  };

  // 출결은 중첩 필드 attendance.status (값: 출석/결석/지각/조퇴/미확인). 등원=출석·지각·조퇴.
  const attStatus = r => r.attendance?.status || '';
  const total = dailyRecords.length;
  const attended = dailyRecords.filter(r => ['출석', '지각', '조퇴'].includes(attStatus(r))).length;
  const absent = dailyRecords.filter(r => attStatus(r) === '결석').length;
  const attendanceSummary = `총 ${total}건 / 등원 ${attended}건 / 결석 ${absent}건`;

  const recentAbsences = absenceRecords
    .sort((a, b) => String(b.absence_date || '').localeCompare(String(a.absence_date || '')))
    .slice(0, 5)
    .map(r => `${r.absence_date || '-'}: ${r.reason || '사유없음'} (보충: ${r.makeup_date || '미정'})`)
    .join('\n');

  const consultBody = consultations.map(consultationLine).join('\n');
  const gapLine = gapDays == null
    ? '상담 기록이 전혀 없음 → 첫 상담 필요'
    : gapDays > CONSULT_GAP_DAYS
      ? `마지막 상담 후 ${gapDays}일 경과 (${CONSULT_GAP_DAYS}일 초과) → 상담 공백 주의`
      : `마지막 상담 후 ${gapDays}일 경과`;

  return `
너는 Impact7 학원의 학생 관리 담당자다.
아래 데이터를 보고 한 학생의 최근 ${MONTHS_BACK}개월 종합 상태와 상담 누적요약, 다음 상담 브리핑을 한 번에 작성하라.

규칙:
- 출력은 JSON 객체 하나만. 마크다운 코드블록 금지.
- 모든 텍스트는 한국어.
- 사실 근거 없는 내용 금지. 근거 부족하면 "확인 필요"로 표기.
- status는 good / caution / risk 중 하나 (종합 위험도). 상담 공백이 길면 위험도에 반영.
- status_summary_markdown은 출결·숙제·테스트·상담을 아우르는 3~5줄 핵심 요약.
- consultation_summary_markdown은 상담 이력만의 누적 요약. 상담이 없으면 "상담 기록 없음"이라고만 쓴다.
- briefing_markdown은 다음 상담 직전에 읽는 짧고 실행 가능한 브리핑. 상담이 없으면 첫 상담 시 확인할 점을 쓴다.
- consultation_priority는 normal / watch / urgent 중 하나.
- action_items는 담당 선생님이 즉시 취할 구체적 행동 1~4개.

학생 프로필:
${JSON.stringify(profile, null, 2)}

출결 현황 (최근 ${MONTHS_BACK}개월): ${attendanceSummary}
최근 결석 내역:
${recentAbsences || '없음'}

숙제 미제출: ${failTaskSummary(hwFails)}
테스트 미달: ${failTaskSummary(testFails)}

상담 공백: ${gapLine}
상담 이력 (${consultations.length}건, 오래된→최신):
${consultBody || '없음'}

반환 형식:
{
  "status": "good",
  "status_summary_markdown": "## 종합 요약\\n...",
  "risk_flags": ["..."],
  "action_items": ["..."],
  "attendance_comment": "...",
  "hw_comment": "...",
  "test_comment": "...",
  "consultation_summary_markdown": "## 누적 요약\\n...",
  "consultation_priority": "normal",
  "notable_topics": ["..."],
  "briefing_markdown": "## 다음 상담 브리핑\\n...",
  "recommended_next_actions": ["..."]
}
`.trim();
}

function extractJson(text) {
  const raw = textOf(text).replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new HttpsError('internal', 'AI 응답 JSON 파싱 실패');
  }
}

function strList(v, max) {
  return Array.isArray(v) ? v.map(textOf).filter(Boolean).slice(0, max) : [];
}

function normalizeResult(parsed) {
  const statusSummary = textOf(parsed.status_summary_markdown);
  if (!statusSummary) throw new HttpsError('internal', 'AI 응답에 종합 요약이 없습니다.');
  const status = ['good', 'caution', 'risk'].includes(parsed.status) ? parsed.status : 'caution';
  const priority = ['normal', 'watch', 'urgent'].includes(parsed.consultation_priority)
    ? parsed.consultation_priority : 'normal';
  return {
    status,
    status_summary_markdown: statusSummary,
    risk_flags: strList(parsed.risk_flags, 6),
    action_items: strList(parsed.action_items, 4),
    attendance_comment: textOf(parsed.attendance_comment),
    hw_comment: textOf(parsed.hw_comment),
    test_comment: textOf(parsed.test_comment),
    consultation_summary_markdown: textOf(parsed.consultation_summary_markdown) || '상담 기록 없음',
    consultation_priority: priority,
    notable_topics: strList(parsed.notable_topics, 12),
    briefing_markdown: textOf(parsed.briefing_markdown) || '상담 기록 없음 — 첫 상담 시 학습 태도·출결을 우선 확인.',
    recommended_next_actions: strList(parsed.recommended_next_actions, 8),
  };
}

function writeArtifacts(firestore, { studentId, data, ai, gap, auth }) {
  const base = {
    student_id: studentId,
    student_name: data.student.name || '',
    generated_by: auth.uid,
    generated_by_email: auth.token?.email || '',
    generation_source: 'unified',
    generated_at: FieldValue.serverTimestamp(),
  };

  const batch = firestore.batch();

  batch.set(firestore.collection('student_status_summaries').doc(studentId), {
    ...base,
    analysis_months: MONTHS_BACK,
    daily_record_count: data.dailyRecords.length,
    absence_count: data.absenceRecords.length,
    hw_fail_count: data.hwFails.length,
    test_fail_count: data.testFails.length,
    consultation_count: data.consultations.length,
    status: ai.status,
    summary_markdown: ai.status_summary_markdown,
    risk_flags: ai.risk_flags,
    action_items: ai.action_items,
    attendance_comment: ai.attendance_comment,
    hw_comment: ai.hw_comment,
    test_comment: ai.test_comment,
    consultation_gap_days: gap.days,
    consultation_gap_warning: gap.warning,
    latest_consultation_date: gap.latestDate,
  });

  batch.set(firestore.collection('consultation_summaries').doc(studentId), {
    ...base,
    summary_markdown: ai.consultation_summary_markdown,
    priority: ai.consultation_priority,
    consultation_count: data.consultations.length,
    notable_topics: ai.notable_topics,
    latest_consultation_date: gap.latestDate,
  });

  batch.set(firestore.collection('consultation_briefings').doc(studentId), {
    ...base,
    briefing_markdown: ai.briefing_markdown,
    priority: ai.consultation_priority,
    recommended_next_actions: ai.recommended_next_actions,
    notable_topics: ai.notable_topics,
    next_consultation_scheduled: null,
    latest_consultation_date: gap.latestDate,
  });

  return batch.commit();
}

async function safeLog(entry) {
  try {
    await writeLog(entry);
  } catch (err) {
    console.warn('[generateStudentReportAi] writeLog 실패:', String(err?.message || err));
  }
}

export async function handleGenerateStudentReportAi(request, deps = {}) {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const email = request.auth.token?.email || '';
  if (!isAuthorizedEmail(email)) throw new HttpsError('permission-denied', '허용되지 않은 계정입니다.');

  const studentId = textOf(request.data?.studentId);
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');

  const firestore = deps.firestore || getFirestore();
  const generate = deps.generateText || generateText;
  const today = deps.todayKST ? deps.todayKST() : todayKST();

  try {
    const data = await fetchAllData(firestore, studentId);
    const latestDate = data.consultations.length ? (data.consultations[data.consultations.length - 1].date || null) : null;
    const days = latestDate ? dayDiff(today, latestDate) : null;
    const gap = { days, warning: days == null || days > CONSULT_GAP_DAYS, latestDate };

    const prompt = buildPrompt(data, days);
    const ai = normalizeResult(extractJson(await generate(MODEL, prompt, { temperature: 0.2 })));
    await writeArtifacts(firestore, { studentId, data, ai, gap, auth: request.auth });

    await safeLog({ channel: 'student_report_ai', uid: request.auth.uid, model: MODEL, ok: true, student_id: studentId });
    return {
      ok: true,
      student_id: studentId,
      status: ai.status,
      consultation_count: data.consultations.length,
      consultation_gap_days: gap.days,
      consultation_gap_warning: gap.warning,
    };
  } catch (err) {
    await safeLog({ channel: 'student_report_ai', uid: request.auth.uid, model: MODEL, ok: false, student_id: studentId, error: String(err?.message || err) });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', '학생 종합 AI 생성 실패');
  }
}
