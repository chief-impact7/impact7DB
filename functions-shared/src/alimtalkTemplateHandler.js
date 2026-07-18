import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';

const TOKEN_PATTERN = /#\{[^}]+\}/g;

function tokensIn(value) {
  return new Set(String(value ?? '').match(TOKEN_PATTERN) ?? []);
}

function buttonTokens(buttons = []) {
  const tokens = new Set();
  for (const button of buttons) {
    for (const value of Object.values(button ?? {})) {
      for (const token of tokensIn(value)) tokens.add(token);
    }
  }
  return tokens;
}

export function alimtalkTemplateView(template) {
  const variables = (template?.variables ?? []).map((variable) => variable.name).filter(Boolean);
  const linkTokens = buttonTokens([...(template?.buttons ?? []), ...(template?.quickReplies ?? [])]);
  let unavailableReason = '';
  if (template?.status !== 'APPROVED' || template?.isHidden) unavailableReason = '승인된 공개 템플릿이 아닙니다.';
  else if (linkTokens.size) unavailableReason = '수신자별 링크 데이터가 필요한 템플릿입니다.';

  return {
    templateId: template?.templateId ?? '',
    name: template?.name ?? '',
    content: template?.content ?? '',
    status: template?.status ?? '',
    messageType: template?.messageType ?? '',
    emphasizeType: template?.emphasizeType ?? '',
    variables,
    buttons: [
      ...(template?.buttons ?? []).map((button) => ({ name: button.buttonName ?? '', type: button.buttonType ?? '' })),
      ...(template?.quickReplies ?? []).map((reply) => ({ name: reply.name ?? '', type: reply.linkType ?? '' })),
    ],
    sendable: !unavailableReason,
    unavailableReason,
  };
}

async function defaultContext() {
  const provider = await import('./solapiProvider.js');
  return {
    service: provider.createSolapiService(),
    channelId: provider.SOLAPI_PF_ID,
  };
}

export async function listApprovedAlimtalkTemplates(service, { channelId } = {}) {
  const templates = await fetchAlimtalkTemplates(service, { channelId, status: 'APPROVED', isHidden: false });
  return templates
    .filter((template) => template.status === 'APPROVED' && !template.isHidden)
    .map(alimtalkTemplateView);
}

// 솔라피 템플릿 원본 목록 페이저 — filters(status·isHidden 등) 미지정 시 전 상태를 반환한다.
// 정합성 스윕(templateAuditSweep)은 비승인 상태 감지가 목적이라 필터 없이 쓴다.
export async function fetchAlimtalkTemplates(service, { channelId, ...filters } = {}) {
  const templates = [];
  const seenKeys = new Set();
  let startKey;
  do {
    const response = await service.getKakaoAlimtalkTemplates({
      ...filters,
      ...(channelId ? { channelId } : {}),
      limit: 100,
      ...(startKey ? { startKey } : {}),
    });
    templates.push(...(response?.templateList ?? []));
    const nextKey = response?.nextKey || null;
    if (!nextKey || seenKeys.has(nextKey)) break;
    seenKeys.add(nextKey);
    startKey = nextKey;
  } while (startKey);
  return channelId ? templates.filter((template) => template.channelId === channelId) : templates;
}

export async function getApprovedAlimtalkTemplate(templateId, deps = {}) {
  const context = deps.service
    ? { service: deps.service, channelId: deps.channelId }
    : await (deps.contextFactory ?? defaultContext)();
  const { service, channelId } = context;
  const template = await service.getKakaoAlimtalkTemplate(templateId);
  if (channelId && template?.channelId !== channelId) {
    throw new HttpsError('failed-precondition', '운영 카카오 채널의 템플릿이 아닙니다.');
  }
  const view = alimtalkTemplateView(template);
  if (!view.sendable) {
    throw new HttpsError('failed-precondition', view.unavailableReason || '발송할 수 없는 템플릿입니다.');
  }
  return template;
}

export async function handleGetSolapiAlimtalkTemplates(request, deps = {}) {
  assertAuthorizedStaff(request.auth);
  const context = deps.service
    ? { service: deps.service, channelId: deps.channelId }
    : await (deps.contextFactory ?? defaultContext)();
  return { templates: await listApprovedAlimtalkTemplates(context.service, { channelId: context.channelId }) };
}
