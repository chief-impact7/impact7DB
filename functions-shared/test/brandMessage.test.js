import { describe, it, expect, vi } from 'vitest';
import { sendKakaoBrandMessage } from '../src/solapiProvider.js';

const config = { apiKey: 'k', apiSecret: 's', pfId: 'PF', from: '02-2649-0509' };

function withService(sendImpl) {
  const send = vi.fn(sendImpl);
  return { send, serviceFactory: vi.fn(() => ({ send })) };
}

const okResponse = {
  groupInfo: { groupId: 'G1', count: { registeredSuccess: 1, registeredFailed: 0 }, status: 'COMPLETE' },
  messageList: [{ messageId: 'M1', statusCode: '2000', statusMessage: '정상 접수' }],
  failedMessageList: [],
};

describe('sendKakaoBrandMessage', () => {
  it('builds a BMS_FREE marketing message with SMS fallback off by default', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    const r = await sendKakaoBrandMessage(
      { to: '010-1111-2222', content: '(광고)[임팩트세븐학원] 여름 특강 안내' },
      config,
      { serviceFactory },
    );
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('kakao');
    const msg = send.mock.calls[0][0];
    expect(msg.type).toBe('BMS_FREE');
    expect(msg.to).toBe('01011112222');
    expect(msg.kakaoOptions.pfId).toBe('PF');
    expect(msg.kakaoOptions.adFlag).toBe(true);
    expect(msg.kakaoOptions.disableSms).toBe(true);
    expect(msg.kakaoOptions.bms.targeting).toBe('M');
    expect(msg.kakaoOptions.bms.chatBubbleType).toBe('TEXT');
  });

  it('enables SMS fallback only when disableSms:false is explicit', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    await sendKakaoBrandMessage({ to: '01011112222', content: 'x', disableSms: false }, config, { serviceFactory });
    expect(send.mock.calls[0][0].kakaoOptions.disableSms).toBe(false);
  });

  it('uses IMAGE bubble + imageId when an image is provided', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    await sendKakaoBrandMessage({ to: '01011112222', content: 'x', imageId: 'IMG1' }, config, { serviceFactory });
    const msg = send.mock.calls[0][0];
    expect(msg.kakaoOptions.bms.chatBubbleType).toBe('IMAGE');
    expect(msg.kakaoOptions.imageId).toBe('IMG1');
  });

  it('passes web-link buttons through', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    const buttons = [{ buttonType: 'WL', buttonName: '신청', linkMo: 'https://m', linkPc: 'https://p' }];
    await sendKakaoBrandMessage({ to: '01011112222', content: 'x', buttons }, config, { serviceFactory });
    expect(send.mock.calls[0][0].kakaoOptions.buttons).toEqual(buttons);
  });

  it('allows overriding to an informational (non-ad) message', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    await sendKakaoBrandMessage(
      { to: '01011112222', content: 'x', targeting: 'I', adFlag: false },
      config,
      { serviceFactory },
    );
    const msg = send.mock.calls[0][0];
    expect(msg.kakaoOptions.bms.targeting).toBe('I');
    expect(msg.kakaoOptions.adFlag).toBe(false);
  });

  it('rejects empty content without calling solapi', async () => {
    const { send, serviceFactory } = withService(async () => okResponse);
    const r = await sendKakaoBrandMessage({ to: '01011112222', content: '' }, config, { serviceFactory });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.statusCode).toBe('missing_content');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an empty recipient', async () => {
    const { serviceFactory } = withService(async () => okResponse);
    const r = await sendKakaoBrandMessage({ to: '', content: 'x' }, config, { serviceFactory });
    expect(r.statusCode).toBe('invalid_recipient');
  });

  it('marks network errors retryable', async () => {
    const { serviceFactory } = withService(async () => {
      const e = new Error('net');
      e._tag = 'NetworkError';
      throw e;
    });
    const r = await sendKakaoBrandMessage({ to: '01011112222', content: 'x' }, config, { serviceFactory });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });
});
