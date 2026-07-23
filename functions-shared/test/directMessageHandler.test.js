import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn() }));

const { parseRecipients, parseMmsImage, handleSendDirectMessage } = await import('../src/directMessageHandler.js');

const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';

function makeDb() {
  const docs = {};
  let counter = 0;
  const col = (name) => ({
    doc: (id) => {
      const resolvedId = id ?? `auto_${counter++}`;
      const key = `${name}/${resolvedId}`;
      return {
        id: resolvedId,
        async get() { return { exists: key in docs, data: () => docs[key] }; },
        async set(v) { docs[key] = v; },
        async create(v) {
          if (key in docs) {
            const err = new Error('ALREADY_EXISTS');
            err.code = 6;
            throw err;
          }
          docs[key] = v;
        },
      };
    },
    async add(v) { const id = `auto_${counter++}`; docs[`${name}/${id}`] = v; return { id }; },
  });
  return { _docs: docs, collection: col, batch: () => { const ops = []; return { set: (ref, v) => ops.push({ type: 'set', ref, v }), create: (ref, v) => ops.push({ type: 'create', ref, v }), async commit() { for (const op of ops) { if (op.type === 'create') await op.ref.create(op.v); else await op.ref.set(op.v); } } }; } };
}

const auth = { token: { email: 'staff@impact7.kr' } };

describe('parseRecipients', () => {
  it('splits on newline/comma, keeps 9-11 digit numbers, dedupes', () => {
    const r = parseRecipients('010-1234-5678\n010-1234-5678, 02-2649-0509\nabc, 123');
    expect(r.valid).toEqual(['01012345678', '0226490509']);
    expect(r.invalid).toContain('123');
  });
});

describe('parseMmsImage', () => {
  it('accepts a JPG image up to 200KB', () => {
    expect(parseMmsImage({ name: '안내.jpg', dataBase64: JPEG_BASE64 })).toEqual({
      name: '안내.jpg',
      dataBase64: JPEG_BASE64,
    });
  });

  it('rejects a non-JPG file and oversized payload', () => {
    expect(() => parseMmsImage({ name: '안내.png', dataBase64: JPEG_BASE64 })).toThrow();
    const oversized = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200 * 1024)]).toString('base64');
    expect(() => parseMmsImage({ name: '안내.jpg', dataBase64: oversized })).toThrow();
  });
});

describe('handleSendDirectMessage', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  it('enqueues one direct queue doc per valid number', async () => {
    const res = await handleSendDirectMessage({ auth, data: { recipients: '01011112222\n01033334444', text: '안내' } }, { db });
    expect(res.queued).toBe(2);
    const directDocs = Object.values(db._docs).filter((d) => d.kind === 'direct');
    expect(directDocs).toHaveLength(2);
    expect(directDocs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'direct', status: 'pending', content: '안내', recipient_phone: '01011112222' }),
    ]));
  });

  it('uploads one image and shares its image_id across MMS queue docs', async () => {
    const uploadMmsImage = vi.fn().mockResolvedValue('MMS_FILE_1');
    const res = await handleSendDirectMessage({
      auth,
      data: {
        recipients: '01011112222\n01033334444',
        text: '사진 안내',
        requestId: 'mms-1',
        mmsImage: { name: '안내.jpg', dataBase64: JPEG_BASE64 },
      },
    }, { db, uploadMmsImage });

    expect(res.queued).toBe(2);
    expect(uploadMmsImage).toHaveBeenCalledOnce();
    const directDocs = Object.values(db._docs).filter((d) => d.kind === 'direct');
    expect(directDocs).toHaveLength(2);
    expect(directDocs.every((d) => d.image_id === 'MMS_FILE_1')).toBe(true);
  });

  it('MMS 본문이 Solapi 제한을 넘으면 이미지를 업로드하지 않는다', async () => {
    const uploadMmsImage = vi.fn();
    await expect(handleSendDirectMessage({
      auth,
      data: {
        recipients: '01011112222',
        text: '가'.repeat(1001),
        mmsImage: { name: '안내.jpg', dataBase64: JPEG_BASE64 },
      },
    }, { db, uploadMmsImage })).rejects.toThrow('Solapi 발송 제한');
    expect(uploadMmsImage).not.toHaveBeenCalled();
  });

  it('does not upload the image again for a duplicate requestId', async () => {
    const uploadMmsImage = vi.fn().mockResolvedValue('MMS_FILE_1');
    const data = {
      recipients: '01011112222',
      text: '사진 안내',
      requestId: 'mms-duplicate',
      mmsImage: { name: '안내.jpg', dataBase64: JPEG_BASE64 },
    };
    await handleSendDirectMessage({ auth, data }, { db, uploadMmsImage });
    const second = await handleSendDirectMessage({ auth, data }, { db, uploadMmsImage });

    expect(second.duplicate).toBe(true);
    expect(uploadMmsImage).toHaveBeenCalledOnce();
  });

  it('rejects empty text', async () => {
    await expect(handleSendDirectMessage({ auth, data: { recipients: '01011112222', text: '  ' } }, { db })).rejects.toThrow();
  });

  it('길이 초과 정보문자는 거부하고 명시적 선택 시 번호를 붙여 나눈다', async () => {
    const text = '가'.repeat(1001);
    await expect(handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text },
    }, { db })).rejects.toMatchObject({
      code: 'invalid-argument',
      details: expect.objectContaining({ canSplit: true, splitParts: 2 }),
    });
    expect(Object.values(db._docs).filter((doc) => doc.kind === 'direct')).toHaveLength(0);

    const result = await handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text, requestId: 'same-id', splitLongMessage: true },
    }, { db });
    expect(result).toMatchObject({ queued: 2, recipients: 1, splitGroups: 1 });
    const docs = Object.values(db._docs).filter((doc) => doc.kind === 'direct');
    expect(docs.map((doc) => doc.content.slice(0, 5))).toEqual(['[1/2]', '[2/2]']);
    expect(docs.every((doc) => /^direct:same-id:[a-f0-9]{16}$/.test(doc.split_group_id))).toBe(true);
    expect(docs.every((doc) => !doc.split_group_id.includes('01011112222'))).toBe(true);
  });

  it('requestId 없는 분할 발송은 호출마다 다른 그룹을 사용한다', async () => {
    const data = { recipients: '01011112222', text: '가'.repeat(1001), splitLongMessage: true };
    await handleSendDirectMessage({ auth, data }, { db });
    await handleSendDirectMessage({ auth, data }, { db });
    const groups = new Set(Object.values(db._docs)
      .filter((doc) => doc.kind === 'direct')
      .map((doc) => doc.split_group_id));
    expect(groups.size).toBe(2);
  });

  it('rejects when no valid recipients', async () => {
    await expect(handleSendDirectMessage({ auth, data: { recipients: 'abc', text: 'x' } }, { db })).rejects.toThrow();
  });

  it('is idempotent on requestId (no double enqueue)', async () => {
    const data = { recipients: '01011112222', text: '안내', requestId: 'req-1' };
    await handleSendDirectMessage({ auth, data }, { db });
    const second = await handleSendDirectMessage({ auth, data }, { db });
    expect(second.duplicate).toBe(true);
    expect(Object.values(db._docs).filter((d) => d.kind === 'direct')).toHaveLength(1);
    const fingerprint = db._docs['direct_batches/req-1'].request_fingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain('01011112222');
  });

  it('fingerprint 없는 구버전 requestId 센티널도 중복으로 처리한다', async () => {
    db._docs['direct_batches/legacy-direct'] = { count: 1 };

    const result = await handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text: '안내', requestId: 'legacy-direct' },
    }, { db });

    expect(result).toMatchObject({ queued: 0, duplicate: true });
    expect(Object.values(db._docs).filter((doc) => doc.kind === 'direct')).toHaveLength(0);
  });

  it('같은 requestId로 내용이나 대상이 바뀐 재시도는 거부한다', async () => {
    const data = { recipients: '01011112222', text: '안내', requestId: 'req-changed' };
    await handleSendDirectMessage({ auth, data }, { db });

    await expect(handleSendDirectMessage({
      auth,
      data: { ...data, text: '수정 안내' },
    }, { db })).rejects.toThrow('이전 요청과 다릅니다');
    await expect(handleSendDirectMessage({
      auth,
      data: { ...data, recipients: '01033334444' },
    }, { db })).rejects.toThrow('이전 요청과 다릅니다');
    expect(Object.values(db._docs).filter((d) => d.kind === 'direct')).toHaveLength(1);
  });

  it('rejects more than MAX_RECIPIENTS recipients', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `010${String(i).padStart(8, '0')}`).join('\n');
    await expect(handleSendDirectMessage({ auth, data: { recipients: many, text: 'x' } }, { db })).rejects.toThrow();
  });

  it('propagates scheduledAt to scheduled_date', async () => {
    await handleSendDirectMessage({ auth, data: { recipients: '01011112222', text: '안내', scheduledAt: '2026-07-01T09:00:00+09:00' } }, { db });
    const doc = Object.values(db._docs).find((d) => d.kind === 'direct');
    expect(doc.scheduled_date).toBe('2026-07-01T09:00:00+09:00');
  });

  it('rejects a malformed info scheduledAt instead of silently sending now', async () => {
    await expect(handleSendDirectMessage({
      auth, data: { recipients: '01011112222', text: '안내', scheduledAt: '2026/07/20 3pm' },
    }, { db })).rejects.toThrow('예약시각 형식');
  });

  it('sets scheduled_date to null when scheduledAt is omitted', async () => {
    await handleSendDirectMessage({ auth, data: { recipients: '01011112222', text: '안내' } }, { db });
    const doc = Object.values(db._docs).find((d) => d.kind === 'direct');
    expect(doc.scheduled_date).toBeNull();
  });

  it('enqueues compliant promotional messages with a manual consent snapshot', async () => {
    const now = new Date('2026-07-14T01:00:00.000Z');
    await handleSendDirectMessage({
      auth,
      data: {
        recipients: '01011112222',
        text: '(광고) [임팩트세븐학원]\n여름 특강\n무료수신거부 080-500-4233',
        messageKind: 'promo',
        consentConfirmed: true,
      },
    }, { db, now });
    const doc = Object.values(db._docs).find((d) => d.kind === 'promo_sms');
    expect(doc).toMatchObject({
      ad_flag: true,
      consent_snapshot: { sms: true, source: 'manual_confirmation', at: now.toISOString() },
    });
  });

  it('rejects promotional messages without consent confirmation or required labels', async () => {
    await expect(handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text: '(광고) 안내\n수신거부 080', messageKind: 'promo' },
    }, { db })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text: '안내', messageKind: 'promo', consentConfirmed: true },
    }, { db })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an unknown message kind', async () => {
    await expect(handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text: '안내', messageKind: 'unknown' },
    }, { db })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('알림톡 채널이면 승인 템플릿 검증 후 bulk_alimtalk 큐를 등록한다', async () => {
    const template = {
      templateId: 'TPL_NOTICE', name: '공지', status: 'APPROVED',
      content: '#{학생명}님, 상담은 #{상담일시}입니다.',
      variables: [{ name: '#{학생명}' }, { name: '#{상담일시}' }], buttons: [],
    };
    const getAlimtalkTemplate = vi.fn().mockResolvedValue(template);
    const res = await handleSendDirectMessage({
      auth,
      data: {
        channel: 'alimtalk', templateId: 'TPL_NOTICE',
        recipients: '01011112222\n01033334444',
        templateVariables: { '#{학생명}': '학부모', '#{상담일시}': '7월 20일 15시' },
        requestId: 'direct-alimtalk-1',
      },
    }, { db, getAlimtalkTemplate });
    expect(getAlimtalkTemplate).toHaveBeenCalledWith('TPL_NOTICE');
    expect(res.queued).toBe(2);
    const queue = Object.values(db._docs).filter((doc) => doc.kind === 'bulk_alimtalk');
    expect(queue).toHaveLength(2);
    expect(queue[0]).toMatchObject({
      status: 'pending', template_code: 'TPL_NOTICE',
      template_variables: { '#{학생명}': '학부모', '#{상담일시}': '7월 20일 15시' },
      fallback_text: '학부모님, 상담은 7월 20일 15시입니다.',
      created_by: 'staff@impact7.kr',
    });
  });

  it('알림톡 채널은 #{학생명} 값 누락·홍보성·MMS를 거부한다', async () => {
    const template = {
      templateId: 'TPL_NOTICE', name: '공지', status: 'APPROVED',
      content: '#{학생명}님 안내', variables: [{ name: '#{학생명}' }], buttons: [],
    };
    const getAlimtalkTemplate = vi.fn().mockResolvedValue(template);
    await expect(handleSendDirectMessage({
      auth,
      data: { channel: 'alimtalk', templateId: 'TPL_NOTICE', recipients: '01011112222', templateVariables: {} },
    }, { db, getAlimtalkTemplate })).rejects.toThrow('템플릿 변수 값을 입력하세요: #{학생명}');
    await expect(handleSendDirectMessage({
      auth,
      data: { channel: 'alimtalk', templateId: 'TPL_NOTICE', recipients: '01011112222', messageKind: 'promo' },
    }, { db })).rejects.toThrow('정보성 발송만');
    await expect(handleSendDirectMessage({
      auth,
      data: { channel: 'alimtalk', templateId: 'TPL_NOTICE', recipients: '01011112222', mmsImage: { name: 'a.jpg', dataBase64: JPEG_BASE64 } },
    }, { db })).rejects.toThrow('MMS 이미지를 첨부할 수 없습니다');
  });

  it('치환 후 초과 알림톡은 선택 시 분할 문자로 전환한다', async () => {
    const template = {
      templateId: 'TPL_LONG',
      name: '긴 안내',
      content: `${'가'.repeat(30)}#{학생명}`,
      variables: [{ name: '#{학생명}' }],
      buttons: [],
    };
    const getAlimtalkTemplate = vi.fn().mockResolvedValue(template);
    const data = {
      channel: 'alimtalk',
      templateId: 'TPL_LONG',
      recipients: '01011112222',
      templateVariables: { '#{학생명}': '나'.repeat(980) },
    };
    await expect(handleSendDirectMessage({ auth, data }, { db, getAlimtalkTemplate }))
      .rejects.toMatchObject({ details: expect.objectContaining({ actualChars: 1010, splitParts: 2 }) });

    const result = await handleSendDirectMessage(
      { auth, data: { ...data, splitLongMessage: true } },
      { db, getAlimtalkTemplate },
    );
    expect(result).toMatchObject({ queued: 2, convertedToSms: 2 });
    expect(Object.values(db._docs).filter((doc) => doc.fallback_from_alimtalk)).toHaveLength(2);
  });
});

describe('parseRecipients — invalid token coverage', () => {
  it('includes non-numeric token in invalid', () => {
    const r = parseRecipients('abc');
    expect(r.invalid).toContain('abc');
  });
});
