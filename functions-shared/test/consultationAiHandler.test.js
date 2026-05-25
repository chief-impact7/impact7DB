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

const { handleGenerateStudentConsultationAi } = await import('../src/consultationAiHandler.js');

function makeFirestore() {
  const writes = [];
  const docs = {
    students: {
      s1: { exists: true, data: () => ({ name: '김학생', status: '재원', grade: '중2' }) },
    },
  };
  const consultations = [
    { id: 'c2', data: () => ({ student_id: 's1', date: '2026-05-01', text: '숙제 관리 필요', consultation_type: '학부모요청' }) },
    { id: 'c1', data: () => ({ student_id: 's1', date: '2026-04-01', text: '학습 태도 상담', consultation_type: '정기' }) },
  ];
  const firestore = {
    collection(name) {
      return {
        doc(id) {
          return {
            id,
            async get() {
              return docs[name]?.[id] || { exists: false };
            },
          };
        },
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        async get() {
          return { docs: name === 'consultations' ? consultations : [] };
        },
      };
    },
    batch() {
      return {
        set(ref, data) {
          writes.push({ ref, data });
        },
        async commit() {},
      };
    },
    writes,
  };
  return firestore;
}

const auth = {
  uid: 'u1',
  token: { email: 'teacher@impact7.kr' },
};

describe('handleGenerateStudentConsultationAi', () => {
  let firestore;
  let generateText;

  beforeEach(() => {
    firestore = makeFirestore();
    generateText = vi.fn().mockResolvedValue(JSON.stringify({
      summary_markdown: '## 누적 요약\n관리 필요',
      briefing_markdown: '## 다음 상담 브리핑\n숙제 확인',
      priority: 'watch',
      recommended_next_actions: ['숙제 루틴 확인'],
      notable_topics: ['숙제'],
    }));
  });

  it('requires auth', async () => {
    await expect(handleGenerateStudentConsultationAi({ data: { studentId: 's1' } }, { firestore, generateText }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-impact7 email', async () => {
    await expect(handleGenerateStudentConsultationAi({
      auth: { uid: 'u1', token: { email: 'x@example.com' } },
      data: { studentId: 's1' },
    }, { firestore, generateText })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('generates and writes summary plus briefing for one student', async () => {
    const result = await handleGenerateStudentConsultationAi({ auth, data: { studentId: 's1' } }, { firestore, generateText });
    expect(result).toMatchObject({
      ok: true,
      student_id: 's1',
      source_consultation_count: 2,
      analyzed_consultation_count: 2,
      latest_consultation_date: '2026-05-01',
    });
    expect(generateText).toHaveBeenCalledWith('gemini-3.5-flash', expect.stringContaining('김학생'), { temperature: 0.2 });
    expect(firestore.writes).toHaveLength(2);
    expect(firestore.writes[0].data).toMatchObject({
      student_id: 's1',
      student_name: '김학생',
      summary_markdown: '## 누적 요약\n관리 필요',
      priority: 'watch',
      generated_by: 'u1',
      generated_by_email: 'teacher@impact7.kr',
      generation_source: 'student_manual',
    });
    expect(firestore.writes[1].data).toMatchObject({
      student_id: 's1',
      briefing_markdown: '## 다음 상담 브리핑\n숙제 확인',
      recommended_next_actions: ['숙제 루틴 확인'],
    });
  });

  it('throws failed-precondition when consultation history is empty', async () => {
    firestore.collection = (name) => ({
      doc: (id) => ({ get: async () => name === 'students' ? { exists: true, data: () => ({ name: id }) } : { exists: false } }),
      where() { return this; },
      orderBy() { return this; },
      get: async () => ({ docs: [] }),
    });
    await expect(handleGenerateStudentConsultationAi({ auth, data: { studentId: 's1' } }, { firestore, generateText }))
      .rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
