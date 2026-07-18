import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn() }));

const {
  alimtalkTemplateView,
  getApprovedAlimtalkTemplate,
  handleGetSolapiAlimtalkTemplates,
  listApprovedAlimtalkTemplates,
} = await import('../src/alimtalkTemplateHandler.js');
const { assertAuthorizedStaff } = await import('../src/authGuards.js');

const approved = (overrides = {}) => ({
  templateId: 'TPL1',
  channelId: 'PF1',
  name: '상담 안내',
  content: '#{학생명} 학생 상담은 #{일시}입니다.',
  status: 'APPROVED',
  isHidden: false,
  messageType: 'BA',
  emphasizeType: 'NONE',
  variables: [{ name: '#{학생명}' }, { name: '#{일시}' }],
  buttons: [],
  ...overrides,
});

describe('alimtalkTemplateView', () => {
  it('학생명 본문 템플릿은 발송 가능하며 필요한 필드만 반환한다', () => {
    const view = alimtalkTemplateView(approved({ comments: [{ content: 'secret' }], accountId: 'account' }));
    expect(view).toMatchObject({ templateId: 'TPL1', sendable: true, variables: ['#{학생명}', '#{일시}'] });
    expect(view).not.toHaveProperty('comments');
    expect(view).not.toHaveProperty('accountId');
  });

  it('직원용 또는 버튼 링크 변수가 필요한 템플릿은 목록에 표시하되 발송 불가 처리한다', () => {
    expect(alimtalkTemplateView(approved({ content: '#{성함} 선생님', variables: [{ name: '#{성함}' }] })))
      .toMatchObject({ sendable: false, unavailableReason: '학생 학부모 단체발송용 템플릿이 아닙니다.' });
    expect(alimtalkTemplateView(approved({
      buttons: [{ buttonName: '확인', buttonType: 'WL', linkMo: 'https://example.test/#{token}' }],
      variables: [{ name: '#{학생명}' }, { name: '#{token}' }],
    }))).toMatchObject({ sendable: false, unavailableReason: '학생별 링크 데이터가 필요한 템플릿입니다.' });
    expect(alimtalkTemplateView(approved({
      quickReplies: [{ name: '바로가기', linkType: 'WL', linkMo: 'https://example.test/#{token}' }],
      variables: [{ name: '#{학생명}' }, { name: '#{token}' }],
    }))).toMatchObject({
      sendable: false,
      unavailableReason: '학생별 링크 데이터가 필요한 템플릿입니다.',
      buttons: [{ name: '바로가기', type: 'WL' }],
    });
  });
});

describe('Solapi 알림톡 템플릿 조회', () => {
  it('nextKey를 따라 승인·공개 템플릿을 모두 조회한다', async () => {
    const service = {
      getKakaoAlimtalkTemplates: vi.fn()
        .mockResolvedValueOnce({ templateList: [approved()], nextKey: 'next' })
        .mockResolvedValueOnce({ templateList: [approved({ templateId: 'TPL2', name: '시험 안내' })], nextKey: null }),
    };
    const result = await listApprovedAlimtalkTemplates(service, { channelId: 'PF1' });
    expect(result.map((template) => template.templateId)).toEqual(['TPL1', 'TPL2']);
    expect(service.getKakaoAlimtalkTemplates).toHaveBeenNthCalledWith(1, expect.objectContaining({ channelId: 'PF1' }));
    expect(service.getKakaoAlimtalkTemplates).toHaveBeenNthCalledWith(2, expect.objectContaining({ startKey: 'next' }));
  });

  it('callable은 직원 인증을 검사한다', async () => {
    const service = { getKakaoAlimtalkTemplates: vi.fn().mockResolvedValue({ templateList: [], nextKey: null }) };
    await handleGetSolapiAlimtalkTemplates({ auth: { uid: 'u1' } }, { service });
    expect(assertAuthorizedStaff).toHaveBeenCalled();
  });

  it('발송 직전 상세 조회 결과가 부적합하면 거부한다', async () => {
    const service = { getKakaoAlimtalkTemplate: vi.fn().mockResolvedValue(approved({ status: 'REJECTED' })) };
    await expect(getApprovedAlimtalkTemplate('TPL1', { service })).rejects.toThrow('승인된 공개 템플릿');
  });

  it('발송 직전 운영 카카오 채널과 다른 템플릿을 거부한다', async () => {
    const service = { getKakaoAlimtalkTemplate: vi.fn().mockResolvedValue(approved({ channelId: 'OTHER' })) };
    await expect(getApprovedAlimtalkTemplate('TPL1', { service, channelId: 'PF1' })).rejects.toThrow('운영 카카오 채널');
  });
});
