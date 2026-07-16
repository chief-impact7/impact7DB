import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<serverTimestamp>' },
}));

vi.mock('../src/vertex.js', () => ({
  generateText: vi.fn(),
}));

const { handleGenerateBoardBriefing } = await import('../src/boardBriefingHandler.js');

// board_cards where().where().get() 체이닝 + board_briefings doc().get()/set() 모두 흉내낸다.
// studentReportAiHandler.test.js의 mock firestore 컨벤션을 그대로 따른다.
function makeFirestore({ cards = [], briefingDoc = null } = {}) {
  const writes = [];
  function boardCardsColl() {
    return {
      where() {
        return this;
      },
      async get() {
        return { docs: cards.map((c) => ({ data: () => c })) };
      },
    };
  }
  function briefingsColl() {
    return {
      doc(id) {
        return {
          id,
          async get() {
            if (briefingDoc && briefingDoc.id === id) {
              return { exists: true, data: () => briefingDoc.data };
            }
            return { exists: false, data: () => undefined };
          },
          async set(data, opts) {
            writes.push({ id, data, opts });
          },
        };
      },
    };
  }
  return {
    collection(name) {
      if (name === 'board_cards') return boardCardsColl();
      if (name === 'board_briefings') return briefingsColl();
      throw new Error(`unexpected collection: ${name}`);
    },
    writes,
  };
}

const auth = { uid: 'u1', token: { email: 'teacher@impact7.kr' } };
const todayKST = () => '2026-07-17';
const now = () => Date.parse('2026-07-17T00:00:00Z');

describe('handleGenerateBoardBriefing', () => {
  let generateText;

  beforeEach(() => {
    generateText = vi.fn().mockResolvedValue('## 주간 브리핑\n요약 내용');
  });

  it('requires auth', async () => {
    const firestore = makeFirestore();
    await expect(
      handleGenerateBoardBriefing({ data: { board: 'ops' } }, { firestore, generateText, todayKST, now }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-impact7 email', async () => {
    const firestore = makeFirestore();
    await expect(
      handleGenerateBoardBriefing(
        { auth: { uid: 'u1', token: { email: 'x@example.com' } }, data: { board: 'ops' } },
        { firestore, generateText, todayKST, now },
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects an invalid board', async () => {
    const firestore = makeFirestore();
    await expect(
      handleGenerateBoardBriefing({ auth, data: { board: 'bogus' } }, { firestore, generateText, todayKST, now }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('returns the cached briefing without calling Gemini when one exists for the week', async () => {
    const firestore = makeFirestore({
      briefingDoc: { id: 'ops_2026-W29', data: { markdown: '캐시된 브리핑' } },
    });
    const result = await handleGenerateBoardBriefing(
      { auth, data: { board: 'ops' } },
      { firestore, generateText, todayKST, now },
    );

    expect(result).toEqual({ markdown: '캐시된 브리핑', cached: true });
    expect(generateText).not.toHaveBeenCalled();
    expect(firestore.writes).toHaveLength(0);
  });

  it('regenerates even with a cached doc when force is true', async () => {
    const firestore = makeFirestore({
      briefingDoc: { id: 'ops_2026-W29', data: { markdown: '캐시된 브리핑' } },
      cards: [],
    });
    const result = await handleGenerateBoardBriefing(
      { auth, data: { board: 'ops', force: true } },
      { firestore, generateText, todayKST, now },
    );

    expect(result).toEqual({ markdown: '## 주간 브리핑\n요약 내용', cached: false });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('builds a snapshot (counts/overdue/stale/due-this-week) and writes the merge doc', async () => {
    const cards = [
      // 마감 지남 — doing, 2026-07-10 < today
      { title: '교재 발주', column: 'doing', due_date: '2026-07-10' },
      // 7일 이상 정체 — review, updated_at 10일 전
      {
        title: '레벨테스트 확인',
        column: 'review',
        updated_at: { toMillis: () => now() - 10 * 86400000 },
      },
      // 이번 주 마감 예정 — todo, 2026-07-20
      { title: '학부모 안내문', column: 'todo', due_date: '2026-07-20' },
      // done 컬럼은 어떤 목록에도 잡히지 않아야 한다
      { title: '완료된 일', column: 'done', due_date: '2026-07-01' },
    ];
    const firestore = makeFirestore({ cards });

    const result = await handleGenerateBoardBriefing(
      { auth, data: { board: 'ops' } },
      { firestore, generateText, todayKST, now },
    );

    expect(result).toEqual({ markdown: '## 주간 브리핑\n요약 내용', cached: false });

    const prompt = generateText.mock.calls[0][1];
    expect(generateText.mock.calls[0][0]).toBe('gemini-3.1-pro-preview');
    expect(prompt).toContain('교재 발주');
    expect(prompt).toContain('레벨테스트 확인');
    expect(prompt).toContain('10일째 정체');
    expect(prompt).toContain('학부모 안내문');
    expect(prompt).not.toContain('완료된 일');

    expect(firestore.writes).toHaveLength(1);
    const [write] = firestore.writes;
    expect(write.id).toBe('ops_2026-W29');
    expect(write.opts).toEqual({ merge: true });
    expect(write.data).toMatchObject({
      board: 'ops',
      week: '2026-W29',
      markdown: '## 주간 브리핑\n요약 내용',
      generated_by: 'teacher@impact7.kr',
      generated_at: '<serverTimestamp>',
    });
  });

  it('still generates for an empty board and reports "없음" for each list', async () => {
    const firestore = makeFirestore({ cards: [] });
    await handleGenerateBoardBriefing({ auth, data: { board: 'students' } }, { firestore, generateText, todayKST, now });

    const prompt = generateText.mock.calls[0][1];
    expect(prompt.match(/없음/g)?.length).toBe(3);
  });

  it('wraps a Gemini failure as an internal HttpsError', async () => {
    const firestore = makeFirestore({ cards: [] });
    generateText.mockRejectedValue(new Error('quota exceeded'));
    await expect(
      handleGenerateBoardBriefing({ auth, data: { board: 'ops' } }, { firestore, generateText, todayKST, now }),
    ).rejects.toMatchObject({ code: 'internal' });
  });
});
