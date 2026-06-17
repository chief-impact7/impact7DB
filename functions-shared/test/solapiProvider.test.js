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

  it('falls back to the operational sender when env is unset', () => {
    const prev = process.env.SOLAPI_SENDER;
    delete process.env.SOLAPI_SENDER;
    expect(resolveSolapiSender()).toBe('0226490509');
    process.env.SOLAPI_SENDER = '015881588';
    expect(resolveSolapiSender()).toBe('015881588');
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

import { sendSms } from '../src/solapiProvider.js';

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

  it('passes scheduledDate through send options', async () => {
    const send = vi.fn(async () => ({ groupInfo: { groupId: 'g', count: { registeredSuccess: 1 } }, messageList: [{ messageId: 'm' }] }));
    await sendSms({ to: '01011112222', text: 'x', scheduledDate: '2026-06-18 08:00:00' }, cfg, { serviceFactory: () => ({ send }) });
    expect(send.mock.calls[0][1]).toEqual({ showMessageList: true, scheduledDate: '2026-06-18 08:00:00' });
  });

  it('returns permanent failure when recipient or text is empty', async () => {
    expect(await sendSms({ to: '', text: 'x' }, cfg, {})).toMatchObject({ ok: false, retryable: false, statusCode: 'invalid_recipient' });
    expect(await sendSms({ to: '01011112222', text: '' }, cfg, {})).toMatchObject({ ok: false, statusCode: 'missing_text' });
  });
});
