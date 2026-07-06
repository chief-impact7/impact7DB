import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>', delete: () => '<delete>', increment: (n) => `<inc:${n}>` },
}));

const { recordNonFriendTarget, removeNonFriendTarget } = await import('../src/nonFriendTargets.js');
const { handleGetChannelInviteTargets, handleManageChannelInviteTarget } = await import('../src/channelInviteTargetsHandler.js');

// kakao_nonfriend_targets/students를 흉내내는 인메모리 Firestore.
function makeDb(initialTargets = {}, initialStudents = {}) {
  const targets = new Map(Object.entries(initialTargets));
  const students = new Map(Object.entries(initialStudents));

  function docRef(collMap, id) {
    return {
      id,
      async get() {
        const data = collMap.get(id);
        return { exists: data !== undefined, data: () => data };
      },
      async set(data, opts) {
        if (opts?.merge) collMap.set(id, { ...(collMap.get(id) ?? {}), ...data });
        else collMap.set(id, data);
      },
      async update(patch) {
        collMap.set(id, { ...(collMap.get(id) ?? {}), ...patch });
      },
      async delete() {
        collMap.delete(id);
      },
    };
  }

  function query(collMap) {
    const filters = [];
    let limitN = null;
    const q = {
      where(field, op, val) { filters.push([field, op, val]); return q; },
      orderBy() { return q; },
      limit(n) { limitN = n; return q; },
      async get() {
        let docs = [];
        for (const [id, data] of collMap) {
          const ok = filters.every(([f, op, v]) => {
            if (op === '==') return data[f] === v;
            if (op === '>=') return (data[f]?.toMillis?.() ?? data[f]) >= (v?.getTime?.() ?? v);
            return true;
          });
          if (ok) docs.push({ id, data: () => data, ref: docRef(collMap, id) });
        }
        if (limitN != null) docs = docs.slice(0, limitN);
        return { docs };
      },
    };
    return q;
  }

  return {
    collection(name) {
      const map = name === 'students' ? students : targets;
      return {
        doc: (id) => docRef(map, id),
        where: (...a) => query(map).where(...a),
        orderBy: (...a) => query(map).orderBy(...a),
      };
    },
    _targets: targets,
    _students: students,
  };
}

const staffReq = (data = {}) => ({ data, auth: { uid: 'u1', token: { email: 'staff@impact7.kr' } } });
const ms = (n) => ({ toMillis: () => n });

describe('nonFriendTargets — 기록/제거', () => {
  it('recordNonFriendTarget: upsert + 숨김 해제 + 카운트 증가, 영구 제외·기존 키는 유지', async () => {
    const db = makeDb({ '01011112222': { phone: '01011112222', key: 'existing-key', excluded: true, hidden_at: '<old>' } });
    await recordNonFriendTarget(db, { phone: '010-1111-2222', studentId: 's1', kind: 'parent_bms' });
    const doc = db._targets.get('01011112222');
    expect(doc.key).toBe('existing-key'); // 키는 최초 1회 발급 후 유지 — 클라 in-flight 키 무효화 방지
    expect(doc.convert_count).toBe('<inc:1>');
    expect(doc.hidden_at).toBe('<delete>');
    expect(doc.student_id).toBe('s1');
    expect(doc.excluded).toBe(true); // merge — 영구 제외 유지
  });

  it('recordNonFriendTarget: 새 doc 키는 랜덤(번호 비유도) 32-hex', async () => {
    const db = makeDb();
    await recordNonFriendTarget(db, { phone: '01011112222' });
    const doc = db._targets.get('01011112222');
    expect(doc.key).toMatch(/^[0-9a-f]{32}$/);
    // 해시(번호 유도)면 마스킹 뒤 4자리와 조합해 브루트포스로 번호가 역산된다 — 랜덤이어야 §2.5 유지.
    const db2 = makeDb();
    await recordNonFriendTarget(db2, { phone: '01011112222' });
    expect(db2._targets.get('01011112222').key).not.toBe(doc.key);
  });

  it('recordNonFriendTarget: 번호 없으면 no-op', async () => {
    const db = makeDb();
    await recordNonFriendTarget(db, { phone: '' });
    expect(db._targets.size).toBe(0);
  });

  it('removeNonFriendTarget: 가입 확인 시 제거(없으면 멱등), 영구 제외 doc은 보존', async () => {
    const db = makeDb({
      '01011112222': { phone: '01011112222' },
      '01033334444': { phone: '01033334444', excluded: true, excluded_by: 'staff@impact7.kr' },
    });
    await removeNonFriendTarget(db, '010-1111-2222');
    expect(db._targets.has('01011112222')).toBe(false);
    await removeNonFriendTarget(db, '01011112222'); // 멱등
    await removeNonFriendTarget(db, '01033334444');
    // 삭제하면 재전환 시 excluded 없는 새 doc이 생겨 운영자 결정·감사 기록이 소실된다.
    expect(db._targets.get('01033334444')).toMatchObject({ excluded: true, excluded_by: 'staff@impact7.kr' });
  });
});

describe('handleGetChannelInviteTargets', () => {
  const target = (phone, over = {}) => ({
    phone,
    key: `key-${phone}`,
    convert_count: 2,
    last_converted_at: ms(1000),
    last_kind: 'parent_bms',
    ...over,
  });

  it('미로그인 거부', async () => {
    await expect(handleGetChannelInviteTargets({ data: {} }, { firestore: makeDb() }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('기본: 활성만 + 마스킹 번호 + 불투명 키(평문 번호 미반출)', async () => {
    const db = makeDb({
      '01011112222': target('01011112222'),
      '01033334444': target('01033334444', { hidden_at: ms(1) }),
      '01055556666': target('01055556666', { excluded: true }),
    });
    const res = await handleGetChannelInviteTargets(staffReq(), { firestore: db });
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0].masked).not.toContain('1111');
    expect(res.targets[0].key).toBe('key-01011112222');
    expect(res.targets[0]).not.toHaveProperty('phone');
    expect(res.targets[0]).not.toHaveProperty('_target');
    expect(res.hiddenCount).toBe(1);
    expect(res.excludedCount).toBe(1);
  });

  it('includeInactive: 숨김·제외도 플래그와 함께 반환(복원용)', async () => {
    const db = makeDb({
      '01011112222': target('01011112222'),
      '01033334444': target('01033334444', { hidden_at: ms(1) }),
    });
    const res = await handleGetChannelInviteTargets(staffReq({ includeInactive: true }), { firestore: db });
    expect(res.targets).toHaveLength(2);
    expect(res.targets.find(t => t.hidden)).toBeDefined();
  });

  it('이름 매칭: student_id 우선, 없으면 학부모 번호(두 형식) 역조회', async () => {
    const db = makeDb(
      {
        '01011112222': target('01011112222', { student_id: 'st1' }),
        '01033334444': target('01033334444'),
        '01055556666': target('01055556666'),
      },
      {
        st1: { name: '김재원' },
        st2: { name: '박신청', parent_phone_1: '010-3333-4444' },
      },
    );
    const res = await handleGetChannelInviteTargets(staffReq(), { firestore: db });
    const byMasked = Object.fromEntries(res.targets.map(t => [t.masked, t]));
    expect(byMasked['***-****-2222']).toMatchObject({ name: '김재원', matched: 'student' });
    expect(byMasked['***-****-4444']).toMatchObject({ name: '박신청', matched: 'student', studentId: 'st2' });
    expect(byMasked['***-****-6666']).toMatchObject({ matched: 'none' });
  });

  it('sinceMs: 기간 밖(오래된 전환)은 제외', async () => {
    const db = makeDb({
      '01011112222': target('01011112222', { last_converted_at: ms(5000) }),
      '01033334444': target('01033334444', { last_converted_at: ms(100) }),
    });
    const res = await handleGetChannelInviteTargets(staffReq({ sinceMs: 1000 }), { firestore: db });
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0].lastConvertedAt).toBe(5000);
  });
});

describe('handleManageChannelInviteTarget', () => {
  const key = 'key-01011112222';
  const seed = () => makeDb({ '01011112222': { phone: '01011112222', key } });

  it('hide/exclude/invited/restore 각각 반영', async () => {
    const db = seed();
    await handleManageChannelInviteTarget(staffReq({ key, action: 'hide' }), { firestore: db });
    expect(db._targets.get('01011112222')).toMatchObject({ hidden_at: '<ts>', hidden_by: 'staff@impact7.kr' });

    await handleManageChannelInviteTarget(staffReq({ key, action: 'exclude' }), { firestore: db });
    expect(db._targets.get('01011112222').excluded).toBe(true);

    await handleManageChannelInviteTarget(staffReq({ key, action: 'invited' }), { firestore: db });
    expect(db._targets.get('01011112222')).toMatchObject({ invited_at: '<ts>', invited_by: 'staff@impact7.kr' });

    await handleManageChannelInviteTarget(staffReq({ key, action: 'restore' }), { firestore: db });
    expect(db._targets.get('01011112222').hidden_at).toBe('<delete>');
    expect(db._targets.get('01011112222').excluded).toBe('<delete>');
  });

  it('없는 key → not-found, 잘못된 action → invalid-argument', async () => {
    await expect(handleManageChannelInviteTarget(staffReq({ key: 'x'.repeat(24), action: 'hide' }), { firestore: seed() }))
      .rejects.toMatchObject({ code: 'not-found' });
    await expect(handleManageChannelInviteTarget(staffReq({ key, action: 'nuke' }), { firestore: seed() }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
