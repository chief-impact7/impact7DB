import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PARENT_NOTICE_TEMPLATES } from './parentNoticeHandler.js';
import { STAFF_NOTICE_TEMPLATES } from './staffCheckinHandler.js';
import { fetchAlimtalkTemplates } from './alimtalkTemplateHandler.js';

// 알림톡 템플릿 env 키 전체 — 코드 레지스트리에서 유도(하드코딩 목록의 drift 방지).
// ATTENDANCE_TEMPLATE_CODE는 checkinHandler 레거시 출결 경로가 직접 참조한다.
const TEMPLATE_ENV_KEYS = [...new Set([
  'ATTENDANCE_TEMPLATE_CODE',
  ...Object.values(PARENT_NOTICE_TEMPLATES).map((def) => def.envKey),
  ...Object.values(STAFF_NOTICE_TEMPLATES).map((def) => def.envKey),
])];

async function defaultFetchTemplates() {
  const provider = await import('./solapiProvider.js');
  return fetchAlimtalkTemplates(provider.createSolapiService(), { channelId: provider.SOLAPI_PF_ID });
}

// 일 1회: 솔라피 템플릿 목록 ↔ env 템플릿 코드 정합성 대조(T-사고 2회 재발 방지: 07-06 직원 1042
// 101건, 07-16 재등원 1042 3건 — env 미주입·템플릿 수정을 사람이 눈치채는 구조가 없었다).
// - env 값이 솔라피에 없음/비승인/미설정 → 해소될 때까지 매일 기록
// - 새로 승인됐는데 어느 env에도 안 물린 템플릿, 기존 템플릿 변경 감지 → 1회 기록(상태 doc 대조)
// 결과는 template_audit/latest에 남고 발송 현황 callable이 내려준다. 첫 실행은 베이스라인만 기록.
export async function runTemplateAuditSweep(deps = {}) {
  const db = deps.db ?? getFirestore();
  const env = deps.env ?? process.env;
  const templates = await (deps.fetchTemplates ?? defaultFetchTemplates)();

  const byId = new Map(templates.map((t) => [t.templateId, t]));
  const mappedIds = new Set();
  const anomalies = [];

  for (const envKey of TEMPLATE_ENV_KEYS) {
    const code = String(env[envKey] ?? '').trim();
    if (!code) {
      anomalies.push({ type: 'env_unset', envKey, detail: '템플릿 코드 미설정 — fallback 문자로 발송 중' });
      continue;
    }
    mappedIds.add(code);
    const template = byId.get(code);
    if (!template) {
      anomalies.push({ type: 'env_id_missing', envKey, templateId: code, detail: '솔라피에 없는 템플릿 ID — fallback 문자로 발송 중' });
    } else if (template.status !== 'APPROVED') {
      anomalies.push({ type: 'not_approved', envKey, templateId: code, name: template.name ?? '', detail: `템플릿 상태 ${template.status} — fallback 문자로 발송 중` });
    }
  }

  const stateRef = db.collection('template_audit').doc('state');
  const known = (await stateRef.get()).data()?.templates ?? null;
  if (known) {
    for (const template of templates) {
      const prev = known[template.templateId];
      if (prev === undefined) {
        if (template.status === 'APPROVED' && !mappedIds.has(template.templateId)) {
          anomalies.push({ type: 'unmapped_new', templateId: template.templateId, name: template.name ?? '', detail: '새로 승인됐지만 어느 env에도 연결되지 않음' });
        }
      } else if (prev !== String(template.dateUpdated ?? '')) {
        anomalies.push({ type: 'modified', templateId: template.templateId, name: template.name ?? '', detail: '템플릿 변경 감지 — 재검수에 들어가면 승인 전까지 문자로 대체 발송된다' });
      }
    }
  }

  await stateRef.set({
    templates: Object.fromEntries(templates.map((t) => [t.templateId, String(t.dateUpdated ?? '')])),
    checked_at: FieldValue.serverTimestamp(),
  });
  await db.collection('template_audit').doc('latest').set({
    anomalies,
    template_count: templates.length,
    checked_at: FieldValue.serverTimestamp(),
  });
  if (anomalies.length) console.warn('[templateAuditSweep] 이상 감지:', JSON.stringify(anomalies));
  return { anomalies: anomalies.length };
}

export const __testing = { TEMPLATE_ENV_KEYS };
