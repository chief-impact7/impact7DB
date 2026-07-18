import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));

const { runTemplateAuditSweep, __testing } = await import('../src/templateAuditSweep.js');

function makeDb(initial = {}) {
  const docs = new Map(Object.entries(initial));
  return {
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          return {
            async get() {
              const d = docs.get(key);
              return { exists: d !== undefined, data: () => d };
            },
            async set(data) { docs.set(key, data); },
          };
        },
      };
    },
    _docs: docs,
  };
}

const tpl = (id, over = {}) => ({ templateId: id, status: 'APPROVED', name: `t-${id}`, dateUpdated: 'd1', ...over });
const envAllSet = (code) => Object.fromEntries(__testing.TEMPLATE_ENV_KEYS.map((k) => [k, code]));
const latestOf = (db) => db._docs.get('template_audit/latest');

describe('runTemplateAuditSweep', () => {
  it('정합 상태 → 이상 0 + 베이스라인/latest 기록', async () => {
    const db = makeDb();
    const res = await runTemplateAuditSweep({ db, env: envAllSet('A'), fetchTemplates: async () => [tpl('A')] });
    expect(res.anomalies).toBe(0);
    expect(latestOf(db).anomalies).toEqual([]);
    expect(db._docs.get('template_audit/state').templates).toEqual({ A: 'd1' });
  });

  it('env 미설정·솔라피에 없는 ID·비승인 상태를 잡는다', async () => {
    const db = makeDb();
    const env = envAllSet('GONE');
    env[__testing.TEMPLATE_ENV_KEYS[0]] = '';
    env[__testing.TEMPLATE_ENV_KEYS[1]] = 'B';
    await runTemplateAuditSweep({ db, env, fetchTemplates: async () => [tpl('B', { status: 'INSPECTING' })] });
    const types = latestOf(db).anomalies.map((a) => a.type);
    expect(types).toContain('env_unset');
    expect(types).toContain('env_id_missing');
    expect(types).toContain('not_approved');
  });

  it('첫 실행은 미매핑 승인 템플릿을 문제 삼지 않는다(베이스라인)', async () => {
    const db = makeDb();
    await runTemplateAuditSweep({ db, env: envAllSet('A'), fetchTemplates: async () => [tpl('A'), tpl('N')] });
    expect(latestOf(db).anomalies).toEqual([]);
  });

  it('2회차부터 새 미매핑 승인 템플릿과 기존 템플릿 수정을 감지한다', async () => {
    const db = makeDb({ 'template_audit/state': { templates: { A: 'd1' } } });
    await runTemplateAuditSweep({
      db,
      env: envAllSet('A'),
      fetchTemplates: async () => [tpl('A', { dateUpdated: 'd2' }), tpl('N')],
    });
    const anomalies = latestOf(db).anomalies;
    expect(anomalies).toContainEqual(expect.objectContaining({ type: 'modified', templateId: 'A' }));
    expect(anomalies).toContainEqual(expect.objectContaining({ type: 'unmapped_new', templateId: 'N' }));
    expect(db._docs.get('template_audit/state').templates).toEqual({ A: 'd2', N: 'd1' });
  });
});
