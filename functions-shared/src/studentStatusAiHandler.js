import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { generateText } from './vertex.js';
import { writeLog } from './notifyLog.js';

const MODEL = 'gemini-3.1-pro-preview';
const MAX_DAILY_RECORDS = 60;   // 최근 60개 수업 기록
const MAX_CONSULTATIONS = 10;   // 최근 10건 상담
const MONTHS_BACK = 3;

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

// 컬렉션별 인덱스 전략:
// - daily_records: 학생당 누적이 많아 서버 range+정렬+limit (복합 인덱스 student_id+date DESC 사용)
// - consultations: 기존 (student_id, date DESC) 인덱스 재사용
// - absence/hw/test: 학생당 건수가 적어 equality-only 조회 후 메모리에서 cutoff 필터 (신규 인덱스 불필요)
function afterCutoff(docs, field, cutoff) {
  return docs
    .map(d => d.data())
    .filter(r => String(r[field] || '') >= cutoff);
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

  return {
    student: { student_id: studentId, ...studentSnap.data() },
    dailyRecords: dailySnap.docs.map(d => d.data()),
    absenceRecords: afterCutoff(absenceSnap.docs, 'absence_date', cutoff),
    hwFails: afterCutoff(hwSnap.docs, 'source_date', cutoff),
    testFails: afterCutoff(testSnap.docs, 'source_date', cutoff),
    consultations: consultSnap.docs.map(d => d.data()),
  };
}

// hw_fail_tasks/test_fail_tasks의 status는 한국어: 'pending' | '완료' | '취소' | '기타'.
function failTaskSummary(tasks) {
  const pending = tasks.filter(t => t.status === 'pending').length;
  const done = tasks.filter(t => t.status === '완료').length;
  const domains = [...new Set(tasks.map(t => t.domain).filter(Boolean))].join(', ');
  return `총 ${tasks.length}건 (미처리 ${pending}, 완료 ${done}) / 영역: ${domains || '없음'}`;
}

function buildPrompt({ student, dailyRecords, absenceRecords, hwFails, testFails, consultations }) {
  const profile = {
    name: student.name || '',
    status: student.status || '',
    school: student.school || '',
    grade: student.grade || '',
    branch: student.branch || '',
  };

  // 출결은 중첩 필드 attendance.status (값: 출석/결석/지각/조퇴/미확인). 등원=출석·지각·조퇴.
  const total = dailyRecords.length;
  const attStatus = r => r.attendance?.status || '';
  const attended = dailyRecords.filter(r => ['출석', '지각', '조퇴'].includes(attStatus(r))).length;
  const absent = dailyRecords.filter(r => attStatus(r) === '결석').length;
  const attendanceSummary = `총 ${total}건 / 등원 ${attended}건 / 결석 ${absent}건`;

  const recentAbsences = absenceRecords
    .sort((a, b) => String(b.absence_date || '').localeCompare(String(a.absence_date || '')))
    .slice(0, 5)
    .map(r => `${r.absence_date || '-'}: ${r.reason || '사유없음'} (보충: ${r.makeup_date || '미정'})`)
    .join('\n');

  const hwSummary = failTaskSummary(hwFails);
  const testSummary = failTaskSummary(testFails);

  const consultSummary = consultations
    .map(c => `${c.date || '-'} [${c.consultation_type || '-'}] ${textOf(c.text).slice(0, 100)}`)
    .join('\n');

  return `
너는 Impact7 학원의 학생 관리 담당자다.
아래 데이터를 보고 학생의 최근 ${MONTHS_BACK}개월 종합 상태를 분석하라.

규칙:
- 출력은 JSON 객체 하나만. 마크다운 코드블록 금지.
- 모든 텍스트는 한국어.
- 사실 근거 없는 내용 금지. 근거 부족하면 "확인 필요"로 표기.
- status는 good / caution / risk 중 하나.
- summary_markdown은 3~5줄 핵심 요약.
- action_items는 담당 선생님이 즉시 취할 수 있는 구체적 행동 1~4개.

학생 프로필:
${JSON.stringify(profile, null, 2)}

출결 현황 (최근 ${MONTHS_BACK}개월):
${attendanceSummary}

최근 결석 내역:
${recentAbsences || '없음'}

숙제 미제출:
${hwSummary}

테스트 미달:
${testSummary}

최근 상담:
${consultSummary || '없음'}

반환 형식:
{
  "status": "good",
  "summary_markdown": "## 종합 요약\\n...",
  "risk_flags": ["..."],
  "action_items": ["..."],
  "attendance_comment": "...",
  "hw_comment": "...",
  "test_comment": "..."
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

function normalizeResult(parsed) {
  const validStatuses = new Set(['good', 'caution', 'risk']);
  const summary = textOf(parsed.summary_markdown);
  if (!summary) throw new HttpsError('internal', 'AI 응답에 요약이 없습니다.');
  return {
    status: validStatuses.has(parsed.status) ? parsed.status : 'caution',
    summary_markdown: summary,
    risk_flags: Array.isArray(parsed.risk_flags)
      ? parsed.risk_flags.map(textOf).filter(Boolean).slice(0, 6)
      : [],
    action_items: Array.isArray(parsed.action_items)
      ? parsed.action_items.map(textOf).filter(Boolean).slice(0, 4)
      : [],
    attendance_comment: textOf(parsed.attendance_comment),
    hw_comment: textOf(parsed.hw_comment),
    test_comment: textOf(parsed.test_comment),
  };
}

async function safeLog(entry) {
  try {
    await writeLog(entry);
  } catch (err) {
    console.warn('[generateStudentStatusAi] writeLog 실패:', String(err?.message || err));
  }
}

export async function handleGenerateStudentStatusAi(request, deps = {}) {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const email = request.auth.token?.email || '';
  if (!isAuthorizedEmail(email)) throw new HttpsError('permission-denied', '허용되지 않은 계정입니다.');

  const studentId = textOf(request.data?.studentId);
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');

  const firestore = deps.firestore || getFirestore();
  const generate = deps.generateText || generateText;

  try {
    const data = await fetchAllData(firestore, studentId);
    const prompt = buildPrompt(data);
    const parsed = extractJson(await generate(MODEL, prompt, { temperature: 0.2 }));
    const ai = normalizeResult(parsed);

    await firestore.collection('student_status_summaries').doc(studentId).set({
      student_id: studentId,
      student_name: data.student.name || '',
      generated_by: request.auth.uid,
      generated_by_email: email,
      generated_at: FieldValue.serverTimestamp(),
      analysis_months: MONTHS_BACK,
      daily_record_count: data.dailyRecords.length,
      absence_count: data.absenceRecords.length,
      hw_fail_count: data.hwFails.length,
      test_fail_count: data.testFails.length,
      consultation_count: data.consultations.length,
      ...ai,
    });

    await safeLog({ channel: 'student_status_ai', uid: request.auth.uid, model: MODEL, ok: true, student_id: studentId });
    return { ok: true, student_id: studentId, status: ai.status };
  } catch (err) {
    await safeLog({ channel: 'student_status_ai', uid: request.auth.uid, model: MODEL, ok: false, student_id: studentId, error: String(err?.message || err) });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', '학생 상태 AI 생성 실패');
  }
}
