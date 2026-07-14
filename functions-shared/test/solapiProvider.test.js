import { describe, it, expect, vi } from 'vitest';
import { sendKakaoAlimtalk, onlyDigits, resolveSolapiSender } from '../src/solapiProvider.js';

const config = { apiKey: 'k', apiSecret: 's', pfId: 'PF', from: '02-2649-0509' };
const payload = {
  to: '010-1234-5678',
  templateCode: 'TMPL_001',
  templateVariables: { '#{학생명}': '김학생' },
  fallbackText: '[임팩트7 DSC] 김학생 학생이 출석 처리되었습니다.',
};

function withService(sendImpl) {
  const send = vi.fn(sendImpl);
  const serviceFactory = vi.fn(() => ({ send }));
  return { send, serviceFactory };
}

const okResponse = {
  groupInfo: { groupId: 'G1', count: { registeredSuccess: 1, registeredFailed: 0 }, status: 'COMPLETE' },
  messageList: [{ messageId: 'M1', statusCode: '2000', statusMessage: '정상 접수' }],
  failedMessageList: [],
};

describe('onlyDigits / resolveSolapiSender', () => {
  it('strips non-digit characters', () => {
    expect(onlyDigits('010-1234-5678')).toBe('01012345678');
    expect(onlyDigits(null)).toBe('');
  });

  it('always returns the operational sender, ignoring SOLAPI_SENDER env', () => {
    const prev = process.env.SOLAPI_SENDER;
    delete process.env.SOLAPI_SENDER;
    expect(resolveSolapiSender()).toBe('0226490509');
    // env override는 잔존값 사고 방지를 위해 무시한다 — 항상 운영 발신번호.
    process.env.SOLAPI_SENDER = '015881588';
    expect(resolveSolapiSender()).toBe('0226490509');
    if (prev === undefined) delete process.env.SOLAPI_SENDER;
    else process.env.SOLAPI_SENDER = prev;
  });
});

describe('sendKakaoAlimtalk', () => {
  it('builds the alimtalk message with normalized numbers and SMS fallback enabled', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    const result = await sendKakaoAlimtalk(payload, config, { serviceFactory });

    expect(serviceFactory).toHaveBeenCalledWith('k', 's');
    const [message, requestConfig] = send.mock.calls[0];
    expect(message).toMatchObject({
      to: '01012345678',
      from: '0226490509',
      text: payload.fallbackText,
      kakaoOptions: {
        pfId: 'PF',
        templateId: 'TMPL_001',
        variables: { '#{학생명}': '김학생' },
        disableSms: false,
      },
    });
    expect(requestConfig).toEqual({ showMessageList: true });
    expect(result).toEqual({
      ok: true,
      retryable: false,
      channel: 'kakao',
      messageId: 'M1',
      groupId: 'G1',
      statusCode: '2000',
      errorMessage: null,
    });
  });

  it('treats registeredSuccess=0 as a permanent failure (count 객체가 명시적으로 있을 때만)', async () => {
    const { serviceFactory } = withService(async () => ({
      groupInfo: { groupId: 'G2', count: { registeredSuccess: 0, registeredFailed: 1 } },
      failedMessageList: [{ messageId: 'M2', statusCode: '3014', statusMessage: '잘못된 수신번호' }],
    }));
    const result = await sendKakaoAlimtalk(payload, config, { serviceFactory });
    expect(result).toMatchObject({ ok: false, retryable: false, statusCode: '3014' });
  });

  it('treats a missing count object as accepted (ok:true, statusCode count_missing)', async () => {
    // count 자체가 없는 부분/축약 응답 — 실패로 단정하지 않고 접수 간주한다.
    const { serviceFactory } = withService(async () => ({
      groupInfo: { groupId: 'G3' },
      messageList: [{ messageId: 'M4' }],
    }));
    const result = await sendKakaoAlimtalk(payload, config, { serviceFactory });
    expect(result).toMatchObject({
      ok: true,
      retryable: false,
      channel: 'kakao',
      messageId: 'M4',
      groupId: 'G3',
      statusCode: 'count_missing',
    });
  });

  it('keeps a real statusCode even when count is missing', async () => {
    const { serviceFactory } = withService(async () => ({
      groupInfo: { groupId: 'G4', status: 'SENDING' },
      messageList: [{ messageId: 'M5', statusCode: '2000' }],
    }));
    const result = await sendKakaoAlimtalk(payload, config, { serviceFactory });
    expect(result).toMatchObject({ ok: true, statusCode: '2000' });
  });

  it('classifies NetworkError as retryable and always fills a statusCode', async () => {
    const { serviceFactory } = withService(async () => {
      throw { _tag: 'NetworkError', message: 'socket hang up', isRetryable: true };
    });
    const result = await sendKakaoAlimtalk(payload, config, { serviceFactory });
    // statusCode는 ok:false에서 절대 null이 아니다(워커 로그/last_error_code 의존).
    expect(result).toMatchObject({ ok: false, retryable: true, channel: null, statusCode: 'NetworkError' });
  });

  it('accepts the legacy `variables` payload alias', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    await sendKakaoAlimtalk(
      { to: '01012345678', templateCode: 'T', variables: { '#{a}': '1' } },
      config,
      { serviceFactory },
    );
    expect(send.mock.calls[0][0].kakaoOptions.variables).toEqual({ '#{a}': '1' });
  });

  it('classifies ServerError (5xx) as retryable with statusCode', async () => {
    const { serviceFactory } = withService(async () => {
      throw { _tag: 'ServerError', httpStatus: 502, errorCode: 'InternalError', message: 'bad gateway' };
    });
    const result = await sendKakaoAlimtalk(payload, config, { serviceFactory });
    expect(result).toMatchObject({ ok: false, retryable: true, statusCode: '502' });
  });

  it('classifies ClientError 429 as retryable but other 4xx as permanent', async () => {
    const { serviceFactory: f429 } = withService(async () => {
      throw { _tag: 'ClientError', httpStatus: 429, message: 'too many requests' };
    });
    expect(await sendKakaoAlimtalk(payload, config, { serviceFactory: f429 })).toMatchObject({
      retryable: true,
    });
    const { serviceFactory: f400 } = withService(async () => {
      throw { _tag: 'ClientError', httpStatus: 400, message: 'bad request' };
    });
    expect(await sendKakaoAlimtalk(payload, config, { serviceFactory: f400 })).toMatchObject({
      retryable: false,
      statusCode: '400',
    });
  });

  it('classifies BadRequestError as permanent', async () => {
    const { serviceFactory } = withService(async () => {
      throw { _tag: 'BadRequestError', message: 'invalid template variables' };
    });
    const result = await sendKakaoAlimtalk(payload, config, { serviceFactory });
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('maps MessageNotReceivedError using the failed message detail', async () => {
    const { serviceFactory } = withService(async () => {
      throw {
        _tag: 'MessageNotReceivedError',
        failedMessageList: [{ messageId: 'M3', statusCode: '3014', statusMessage: '수신번호 오류' }],
        totalCount: 1,
      };
    });
    const result = await sendKakaoAlimtalk(payload, config, { serviceFactory });
    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      messageId: 'M3',
      statusCode: '3014',
      errorMessage: 'MessageNotReceivedError: 수신번호 오류',
    });
  });

  it('returns a permanent failure without calling the API for a missing recipient', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    const result = await sendKakaoAlimtalk({ ...payload, to: '' }, config, { serviceFactory });
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, retryable: false, statusCode: 'invalid_recipient' });
  });

  it('returns a permanent failure without calling the API when templateCode is missing', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    const result = await sendKakaoAlimtalk({ ...payload, templateCode: '' }, config, { serviceFactory });
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, retryable: false, statusCode: 'missing_template' });
  });

  it('omits the fallback text field when none is provided', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    await sendKakaoAlimtalk({ ...payload, fallbackText: '' }, config, { serviceFactory });
    expect(send.mock.calls[0][0]).not.toHaveProperty('text');
  });
});

import { sendSms, uploadMmsImage } from '../src/solapiProvider.js';

describe('sendSms', () => {
  const cfg = { apiKey: 'k', apiSecret: 's', pfId: 'pf', from: '0226490509' };

  it('sends a plain SMS with normalized numbers and channel=sms', async () => {
    const send = vi.fn(async () => ({
      groupInfo: { groupId: 'g1', count: { registeredSuccess: 1, total: 1 } },
      messageList: [{ messageId: 'm1', statusCode: '2000' }],
    }));
    const serviceFactory = vi.fn(() => ({ send }));
    const res = await sendSms({ to: '010-1234-5678', text: '안내문' }, cfg, { serviceFactory });

    expect(serviceFactory).toHaveBeenCalledWith('k', 's');
    expect(send).toHaveBeenCalledWith(
      { to: '01012345678', from: '0226490509', text: '안내문' },
      { showMessageList: true },
    );
    expect(res).toMatchObject({ ok: true, channel: 'sms', messageId: 'm1', groupId: 'g1' });
  });

  it('adds imageId and reports channel=mms when sending an MMS', async () => {
    const send = vi.fn(async () => ({
      groupInfo: { groupId: 'g1', count: { registeredSuccess: 1 } },
      messageList: [{ messageId: 'm1', statusCode: '2000' }],
    }));
    const res = await sendSms(
      { to: '01011112222', text: '사진 안내', imageId: 'MMS_FILE_1' },
      cfg,
      { serviceFactory: () => ({ send }) },
    );

    expect(send.mock.calls[0][0]).toMatchObject({ imageId: 'MMS_FILE_1' });
    expect(res).toMatchObject({ ok: true, channel: 'mms' });
  });

  it('converts KST scheduledDate to UTC ISO in send options (naive 문자열은 솔라피가 UTC로 오해석)', async () => {
    const send = vi.fn(async () => ({ groupInfo: { groupId: 'g', count: { registeredSuccess: 1 } }, messageList: [{ messageId: 'm' }] }));
    await sendSms({ to: '01011112222', text: 'x', scheduledDate: '2026-06-18 08:00:00' }, cfg, { serviceFactory: () => ({ send }) });
    expect(send.mock.calls[0][1]).toEqual({ showMessageList: true, scheduledDate: '2026-06-17T23:00:00.000Z' });
  });

  it('accepts a Date scheduledDate as-is (absolute time)', async () => {
    const send = vi.fn(async () => ({ groupInfo: { groupId: 'g', count: { registeredSuccess: 1 } }, messageList: [{ messageId: 'm' }] }));
    await sendSms({ to: '01011112222', text: 'x', scheduledDate: new Date('2026-06-17T23:00:00Z') }, cfg, { serviceFactory: () => ({ send }) });
    expect(send.mock.calls[0][1]).toEqual({ showMessageList: true, scheduledDate: '2026-06-17T23:00:00.000Z' });
  });

  it('returns permanent failure when recipient or text is empty', async () => {
    expect(await sendSms({ to: '', text: 'x' }, cfg, {})).toMatchObject({ ok: false, retryable: false, statusCode: 'invalid_recipient' });
    expect(await sendSms({ to: '01011112222', text: '' }, cfg, {})).toMatchObject({ ok: false, statusCode: 'missing_text' });
  });
});

describe('uploadMmsImage', () => {
  const cfg = { apiKey: 'k', apiSecret: 's', from: '0226490509' };

  it('uploads a temporary JPG as MMS and always removes it', async () => {
    const writeFileFn = vi.fn().mockResolvedValue(undefined);
    const unlinkFn = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockResolvedValue({ fileId: 'MMS_FILE_1' });
    const result = await uploadMmsImage(
      { name: '안내.jpg', dataBase64: '/9j/2Q==' },
      cfg,
      { serviceFactory: () => ({ uploadFile }), writeFileFn, unlinkFn },
    );

    expect(writeFileFn).toHaveBeenCalledWith(expect.stringMatching(/impact7-mms-.*\.jpg$/), expect.any(Buffer));
    expect(uploadFile).toHaveBeenCalledWith(expect.stringMatching(/\.jpg$/), 'MMS', '안내.jpg');
    expect(unlinkFn).toHaveBeenCalledWith(expect.stringMatching(/\.jpg$/));
    expect(result).toBe('MMS_FILE_1');
  });

  it('removes the temporary JPG when Solapi upload fails', async () => {
    const unlinkFn = vi.fn().mockResolvedValue(undefined);
    await expect(uploadMmsImage(
      { name: '안내.jpg', dataBase64: '/9j/2Q==' },
      cfg,
      {
        serviceFactory: () => ({ uploadFile: vi.fn().mockRejectedValue(new Error('upload failed')) }),
        writeFileFn: vi.fn().mockResolvedValue(undefined),
        unlinkFn,
      },
    )).rejects.toThrow('upload failed');

    expect(unlinkFn).toHaveBeenCalledOnce();
  });
});

import { fetchSmsResult } from '../src/solapiProvider.js';

describe('fetchSmsResult (SMS/LMS 발송결과 사후 조회)', () => {
  const cfg = { apiKey: 'k', apiSecret: 's', pfId: 'pf', from: '0226490509' };
  const groupRes = (msg) => ({ messageList: { [msg.messageId ?? 'M1']: msg } });
  function withGetGroup(impl) {
    const getGroupMessages = vi.fn(impl);
    return { getGroupMessages, serviceFactory: vi.fn(() => ({ getGroupMessages })) };
  }

  it('4000 수신완료 → delivered', async () => {
    const { serviceFactory, getGroupMessages } = withGetGroup(async () => groupRes({ messageId: 'M1', status: 'COMPLETE', statusCode: '4000', reason: '수신 완료' }));
    const r = await fetchSmsResult('G1', cfg, { serviceFactory });
    expect(getGroupMessages).toHaveBeenCalledWith('G1');
    expect(r).toMatchObject({ outcome: 'delivered', statusCode: '4000' });
  });

  it('3058 전송경로 없음 → failed(재발송 대상)', async () => {
    const { serviceFactory } = withGetGroup(async () => groupRes({ status: 'COMPLETE', statusCode: '3058', reason: '전송경로 없음' }));
    expect(await fetchSmsResult('G1', cfg, { serviceFactory })).toMatchObject({ outcome: 'failed', statusCode: '3058' });
  });

  it('발송 진행중(COMPLETE 아님) → pending', async () => {
    const { serviceFactory } = withGetGroup(async () => groupRes({ status: 'PENDING', statusCode: null }));
    expect((await fetchSmsResult('G1', cfg, { serviceFactory })).outcome).toBe('pending');
  });

  it('결과 메시지 없음 → pending', async () => {
    const { serviceFactory } = withGetGroup(async () => ({ messageList: {} }));
    expect((await fetchSmsResult('G1', cfg, { serviceFactory })).outcome).toBe('pending');
  });

  it('조회 예외 → pending(일시 오류, 재조회 대상)', async () => {
    const { serviceFactory } = withGetGroup(async () => { throw { _tag: 'NetworkError', message: 'timeout' }; });
    expect((await fetchSmsResult('G1', cfg, { serviceFactory })).outcome).toBe('pending');
  });

  it('groupId 없으면 API 호출 없이 failed', async () => {
    const { serviceFactory, getGroupMessages } = withGetGroup(async () => ({}));
    const r = await fetchSmsResult('', cfg, { serviceFactory });
    expect(getGroupMessages).not.toHaveBeenCalled();
    expect(r.outcome).toBe('failed');
  });
});
