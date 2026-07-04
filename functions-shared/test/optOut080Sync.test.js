import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));

const { runOptOut080Sync } = await import('../src/optOut080Sync.js');

function makeDb(students) {
  const writes = [];
  return {
    writes,
    collection: () => ({
      async get() {
        return {
          size: students.length,
          docs: students.map((s) => ({
            id: s.id,
            data: () => s,
            ref: { set: async (data, opts) => writes.push({ id: s.id, data, opts }) },
          })),
        };
      },
    }),
  };
}

describe('runOptOut080Sync', () => {
  it('수신거부 번호를 번호 주인 단위로 철회 기록(학부모→promo, 학생→promo_student)', async () => {
    const db = makeDb([
      { id: 's1', parent_phone_1: '010-1111-2222' },              // 학부모1 거부
      { id: 's2', student_phone: '01033334444', parent_phone_1: '01099990000' }, // 학생 본인 거부
      { id: 's3', parent_phone_1: '01055556666' },                // 명단에 없음
    ]);
    const res = await runOptOut080Sync({ db, loadBlacks: async () => new Set(['01011112222', '01033334444']) });
    expect(res).toMatchObject({ blocked: 2, revoked: 2, scanned: 3 });
    const byId = Object.fromEntries(db.writes.map((w) => [w.id, w.data.message_consent]));
    expect(byId.s1.promo).toMatchObject({ optedIn: false, source: 'optout_080', revokedAt: '<ts>' });
    expect(byId.s2.promo_student).toMatchObject({ optedIn: false, source: 'optout_080' });
    expect(byId.s2.promo).toBeUndefined(); // 학부모1 번호는 명단에 없음
    expect(byId.s3).toBeUndefined();
    expect(db.writes[0].opts).toEqual({ merge: true });
  });

  it('이미 optout_080으로 철회된 학생은 재기록하지 않음(멱등)', async () => {
    const db = makeDb([
      { id: 's1', parent_phone_1: '01011112222', message_consent: { promo: { optedIn: false, source: 'optout_080', revokedAt: '<old>' } } },
    ]);
    const res = await runOptOut080Sync({ db, loadBlacks: async () => new Set(['01011112222']) });
    expect(res.revoked).toBe(0);
    expect(db.writes).toHaveLength(0);
  });

  it('재동의(source 변경) 후에도 명단에 남아 있으면 다시 철회(옵트아웃 우선)', async () => {
    const db = makeDb([
      { id: 's1', parent_phone_1: '01011112222', message_consent: { promo: { optedIn: true, source: 'admin', revokedAt: null } } },
    ]);
    const res = await runOptOut080Sync({ db, loadBlacks: async () => new Set(['01011112222']) });
    expect(res.revoked).toBe(1);
    expect(db.writes[0].data.message_consent.promo.optedIn).toBe(false);
  });

  it('명단이 비면 학생 스캔 없이 종료', async () => {
    const db = makeDb([{ id: 's1', parent_phone_1: '01011112222' }]);
    const res = await runOptOut080Sync({ db, loadBlacks: async () => new Set() });
    expect(res).toEqual({ blocked: 0, revoked: 0, scanned: 0 });
  });
});
