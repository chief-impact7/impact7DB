import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { generateText } from './vertex.js';
import { writeLog } from './notifyLog.js';

const MODEL = 'gemini-3.5-flash';
const MAX_CONSULTATIONS = 120;

function isAuthorizedEmail(email) {
  return /@(gw\.)?impact7\.kr$/i.test(email || '');
}

function textOf(v) {
  return String(v ?? '').trim();
}

function consultationLine(c) {
  const parts = [
    `날짜: ${textOf(c.date) || '-'}`,
    `대상: ${textOf(c.target) || '-'}`,
    `형태: ${textOf(c.method) || '-'}`,
    `유형: ${textOf(c.consultation_type) || '-'}`,
    `상담자: ${textOf(c.teacher_name) || '-'}`,
    `담당: ${textOf(c.assigned_teacher_name) || '-'}`,
  ];
  return `- ${parts.join(' / ')}\n${textOf(c.text)}`;
}

function buildPrompt({ student, consultations }) {
  const profile = {
    name: student.name || '',
    status: student.status || '',
    school: student.school || '',
    grade: student.grade || '',
    branch: student.branch || '',
  };
  const body = consultations.map(consultationLine).join('\n\n');
  return `
너는 Impact7 학원 상담기록을 정리하는 운영 담당자다.
아래 한 학생의 상담 이력만 보고, 저장용 AI 누적요약과 다음 상담 브리핑을 작성하라.

규칙:
- 출력은 JSON 객체 하나만 반환한다. 마크다운 코드블록 금지.
- summary_markdown과 briefing_markdown은 한국어 마크다운 문자열이다.
- 사실이 아닌 내용은 만들지 않는다.
- 다음 상담 브리핑은 바로 상담 전에 읽는 용도라서 짧고 실행 가능하게 쓴다.
- 상담 이력에 근거가 부족하면 "기록상 확인 필요"라고 쓴다.
- priority는 normal, watch, urgent 중 하나다.

학생 프로필:
${JSON.stringify(profile, null, 2)}

상담 이력 (${consultations.length}건):
${body}

반환 형식:
{
  "summary_markdown": "## 누적 요약\\n...",
  "briefing_markdown": "## 다음 상담 브리핑\\n...",
  "priority": "normal",
  "recommended_next_actions": ["..."],
  "notable_topics": ["..."]
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

function normalizeAiResult(parsed) {
  const summary = textOf(parsed.summary_markdown);
  const briefing = textOf(parsed.briefing_markdown);
  if (!summary || !briefing) {
    throw new HttpsError('internal', 'AI 응답에 요약/브리핑이 없습니다.');
  }
  const priority = ['normal', 'watch', 'urgent'].includes(parsed.priority) ? parsed.priority : 'normal';
  return {
    summary_markdown: summary,
    briefing_markdown: briefing,
    priority,
    recommended_next_actions: Array.isArray(parsed.recommended_next_actions)
      ? parsed.recommended_next_actions.map(textOf).filter(Boolean).slice(0, 8)
      : [],
    notable_topics: Array.isArray(parsed.notable_topics)
      ? parsed.notable_topics.map(textOf).filter(Boolean).slice(0, 12)
      : [],
  };
}

async function fetchStudentAndConsultations(firestore, studentId) {
  const studentSnap = await firestore.collection('students').doc(studentId).get();
  if (!studentSnap.exists) throw new HttpsError('not-found', '학생을 찾을 수 없습니다.');

  const consultationSnap = await firestore
    .collection('consultations')
    .where('student_id', '==', studentId)
    .get();
  const allConsultations = consultationSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  if (allConsultations.length === 0) {
    throw new HttpsError('failed-precondition', '상담 이력이 없습니다.');
  }
  return {
    student: { student_id: studentId, ...studentSnap.data() },
    allConsultations,
    consultations: allConsultations.slice(-MAX_CONSULTATIONS),
    latest: allConsultations[allConsultations.length - 1],
  };
}

async function writeAiArtifacts(firestore, { studentId, student, allConsultations, consultations, latest, ai, auth }) {
  const base = {
    student_id: studentId,
    student_name: student.name || '',
    source_consultation_count: allConsultations.length,
    analyzed_consultation_count: consultations.length,
    latest_consultation_date: latest.date || null,
    generated_by: auth.uid,
    generated_by_email: auth.token?.email || '',
    generation_source: 'student_manual',
    generated_at: FieldValue.serverTimestamp(),
  };
  const batch = firestore.batch();
  batch.set(firestore.collection('consultation_summaries').doc(studentId), {
    ...base,
    summary_markdown: ai.summary_markdown,
    priority: ai.priority,
    consultation_count: allConsultations.length,
    notable_topics: ai.notable_topics,
  });
  batch.set(firestore.collection('consultation_briefings').doc(studentId), {
    ...base,
    briefing_markdown: ai.briefing_markdown,
    priority: ai.priority,
    recommended_next_actions: ai.recommended_next_actions,
    notable_topics: ai.notable_topics,
    next_consultation_scheduled: null,
  });
  await batch.commit();
}

async function safeLog(entry) {
  try {
    await writeLog(entry);
  } catch (err) {
    console.warn('[generateStudentConsultationAi] writeLog 실패:', String(err?.message || err));
  }
}

export async function handleGenerateStudentConsultationAi(request, deps = {}) {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const email = request.auth.token?.email || '';
  if (!isAuthorizedEmail(email)) throw new HttpsError('permission-denied', '허용되지 않은 계정입니다.');

  const studentId = textOf(request.data?.studentId);
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');

  const firestore = deps.firestore || getFirestore();
  const generate = deps.generateText || generateText;

  try {
    const fetched = await fetchStudentAndConsultations(firestore, studentId);
    const { student, allConsultations, consultations, latest } = fetched;
    const prompt = buildPrompt({ student, consultations });
    const parsed = extractJson(await generate(MODEL, prompt, { temperature: 0.2 }));
    const ai = normalizeAiResult(parsed);
    await writeAiArtifacts(firestore, { studentId, student, allConsultations, consultations, latest, ai, auth: request.auth });
    await safeLog({ channel: 'consultation_ai', uid: request.auth.uid, model: MODEL, ok: true, student_id: studentId });
    return {
      ok: true,
      student_id: studentId,
      source_consultation_count: allConsultations.length,
      analyzed_consultation_count: consultations.length,
      latest_consultation_date: latest.date || null,
    };
  } catch (err) {
    await safeLog({ channel: 'consultation_ai', uid: request.auth.uid, model: MODEL, ok: false, student_id: studentId, error: String(err?.message || err) });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', '상담 AI 생성 실패');
  }
}
