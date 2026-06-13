import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<serverTimestamp>' },
}));

vi.mock('../src/vertex.js', () => ({
  generateText: vi.fn(),
}));

vi.mock('../src/notifyLog.js', () => ({
  writeLog: vi.fn(),
}));

const { handleGenerateStudentReportAi } = await import('../src/studentReportAiHandler.js');

// consultations 인자로 상담 유무 케이스를 분기. 나머지 컬렉션은 고정 mock.
function makeFirestore(consultations) {
  const writes = [];
  const students = {
    s1: { exists: true, data: () => ({ name: '김학생', status: '재원', grade: '중2', school: 'A중' }) },
  };
  const byCollection = {
    daily_records: [
      { data: () => ({ attendance: { status: '출석' }, date: '2099-06-01' }) },
      { data: () => ({ attendance: { status: '결석' }, date: '2099-05-20' }) },
    ],
    absence_records: [],
    hw_fail_tasks: [],
    test_fail_tasks: [],
    consultations,
  };
  function coll(name) {
    return {
      doc: (id) => ({ id, path: `${name}/${id}`, async get() { return students[id] || { exists: false }; } }),
      where() { return this; },
      orderBy() { return this; },
      limit() { return this; },
      async get() { return { docs: byCollection[name] || [] }; },
    };
  }
  return {
    collection: coll,
    batch() {
      return { set(ref, data) { writes.push({ path: ref.path, data }); }, async commit() {} };
    },
    writes,
  };
}

const auth = { uid: 'u1', token: { email: 'teacher@impact7.kr' } };
const todayKST = () => '2026-06-13';

const aiJson = JSON.stringify({
  status: 'caution',
  status_summary_markdown: '## 종합 요약\n출결 양호, 상담 공백',
  risk_flags: ['상담 공백'],
  action_items: ['상담 예약'],
  attendance_comment: '출결 양호',
  hw_comment: '미제출 없음',
  test_comment: '미달 없음',
  consultation_summary_markdown: '## 누적 요약\n태도 개선 중',
  consultation_priority: 'watch',
  notable_topics: ['숙제'],
  briefing_markdown: '## 다음 상담 브리핑\n숙제 루틴 확인',
  recommended_next_actions: ['숙제 루틴 확인'],
});

describe('handleGenerateStudentReportAi', () => {
  let generateText;

  beforeEach(() => {
    generateText = vi.fn().mockResolvedValue(aiJson);
  });

  it('requires auth', async () => {
    const firestore = makeFirestore([]);
    await expect(handleGenerateStudentReportAi({ data: { studentId: 's1' } }, { firestore, generateText, todayKST }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-impact7 email', async () => {
    const firestore = makeFirestore([]);
    await expect(handleGenerateStudentReportAi({
      auth: { uid: 'u1', token: { email: 'x@example.com' } },
      data: { studentId: 's1' },
    }, { firestore, generateText, todayKST })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('writes all three artifacts in a single Gemini call', async () => {
    const consultations = [
      { id: 'c2', data: () => ({ date: '2026-05-01', text: '숙제 관리', consultation_type: '정기' }) },
      { id: 'c1', data: () => ({ date: '2026-04-01', text: '태도 상담', consultation_type: '정기' }) },
    ];
    const firestore = makeFirestore(consultations);
    const result = await handleGenerateStudentReportAi({ auth, data: { studentId: 's1' } }, { firestore, generateText, todayKST });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith('gemini-3.1-pro-preview', expect.stringContaining('김학생'), { temperature: 0.2 });
    expect(result).toMatchObject({ ok: true, student_id: 's1', status: 'caution', consultation_count: 2 });

    const paths = firestore.writes.map(w => w.path);
    expect(paths).toEqual([
      'student_status_summaries/s1',
      'consultation_summaries/s1',
      'consultation_briefings/s1',
    ]);
    const status = firestore.writes[0].data;
    expect(status).toMatchObject({
      status: 'caution',
      summary_markdown: '## 종합 요약\n출결 양호, 상담 공백',
      daily_record_count: 2,
      consultation_count: 2,
      latest_consultation_date: '2026-05-01',
      generation_source: 'unified',
    });
    // 2026-05-01 → 2026-06-13: 43일 경과(>30) → 공백 경고
    expect(status.consultation_gap_days).toBe(43);
    expect(status.consultation_gap_warning).toBe(true);
    expect(firestore.writes[1].data).toMatchObject({ summary_markdown: '## 누적 요약\n태도 개선 중', priority: 'watch' });
    expect(firestore.writes[2].data).toMatchObject({ briefing_markdown: '## 다음 상담 브리핑\n숙제 루틴 확인' });
  });

  it('still generates with zero consultations and flags the gap', async () => {
    const firestore = makeFirestore([]);
    const result = await handleGenerateStudentReportAi({ auth, data: { studentId: 's1' } }, { firestore, generateText, todayKST });

    expect(result).toMatchObject({ ok: true, consultation_count: 0, consultation_gap_warning: true });
    expect(firestore.writes).toHaveLength(3);
    const status = firestore.writes[0].data;
    expect(status.consultation_gap_days).toBeNull();
    expect(status.consultation_gap_warning).toBe(true);
    expect(status.latest_consultation_date).toBeNull();
  });

  it('does not warn at exactly the gap threshold (30 days)', async () => {
    // 2026-05-14 → 2026-06-13 = 정확히 30일 (초과 아님)
    const consultations = [{ id: 'c1', data: () => ({ date: '2026-05-14', text: '상담', consultation_type: '정기' }) }];
    const firestore = makeFirestore(consultations);
    await handleGenerateStudentReportAi({ auth, data: { studentId: 's1' } }, { firestore, generateText, todayKST });
    const status = firestore.writes[0].data;
    expect(status.consultation_gap_days).toBe(30);
    expect(status.consultation_gap_warning).toBe(false);
  });

  it('throws not-found for unknown student', async () => {
    const firestore = makeFirestore([]);
    await expect(handleGenerateStudentReportAi({ auth, data: { studentId: 'ghost' } }, { firestore, generateText, todayKST }))
      .rejects.toMatchObject({ code: 'not-found' });
  });
});
