import { describe, it, expect, vi } from 'vitest';
import { sendKakaoBrandMessage } from '../src/solapiProvider.js';

const config = { apiKey: 'k', apiSecret: 's', pfId: 'PF', from: '02-2649-0509' };

describe('sendKakaoBrandMessage', () => {
  it('blocks BMS_FREE without calling Solapi', async () => {
    const send = vi.fn();
    const serviceFactory = vi.fn(() => ({ send }));
    const r = await sendKakaoBrandMessage(
      { to: '010-1111-2222', content: '(광고)[임팩트세븐학원] 여름 특강 안내' },
      config,
      { serviceFactory },
    );

    expect(r).toMatchObject({
      ok: false,
      retryable: false,
      statusCode: 'bms_free_disabled',
    });
    expect(serviceFactory).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
