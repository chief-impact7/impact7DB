import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { applyTemplate } from './templates.js';
import { resolveRecipientPhone } from './recipientPhone.js';

// 개별 학부모 정보성 안내(알림톡) 발송 callable. 학생 상세 패널 '메시지' 탭에서 1건 발송.
// 정보성이므로 동의·야간 제한 없음. 승인된 알림톡 템플릿 코드는 .env로 주입(검수 승인 후 확정).
// 홍보(광고)는 별도 경로(createPromoCampaign) — 여기서 다루지 않는다.

const BRAND_PREFIX = '[임팩트세븐학원]';

// kind→템플릿 레지스트리. templateCode는 env(승인 후), vars는 승인 템플릿의 변수명과 일치.
// fallback은 알림톡 실패 시 솔라피 내장 대체발송 SMS 본문.
export const PARENT_NOTICE_TEMPLATES = {
  counsel: {
    envKey: 'COUNSEL_TEMPLATE_CODE',
    label: '상담 안내',
    vars: ['상담일시', '장소'],
    fallback: `${BRAND_PREFIX} 상담 안내\n#{학생명} 학생 학부모님, 상담 일정 안내드립니다.\n일시: #{상담일시} / 장소: #{장소}\n문의: 02-2649-0509`,
  },
  tuition: {
    envKey: 'TUITION_TEMPLATE_CODE',
    label: '수강료 납부 안내',
    vars: ['해당월', '납부금액', '납부기한'],
    fallback: `${BRAND_PREFIX} 수강료 납부 안내\n#{학생명} 학생 #{해당월} 수강료 #{납부금액}, 납부기한 #{납부기한}\n문의: 02-2649-0509`,
  },
  exam: {
    envKey: 'EXAM_TEMPLATE_CODE',
    label: '시험·성적 안내',
    vars: ['시험명', '안내내용'],
    fallback: `${BRAND_PREFIX} 시험·성적 안내\n#{학생명} 학생 #{시험명}: #{안내내용}\n문의: 02-2649-0509`,
  },
  notice: {
    envKey: 'NOTICE_TEMPLATE_CODE',
    label: '휴원·일정 안내',
    vars: ['안내내용', '적용일자'],
    fallback: `${BRAND_PREFIX} 휴원·일정 안내\n#{학생명} 학생 학부모님: #{안내내용} (#{적용일자})\n문의: 02-2649-0509`,
  },
};

// 템플릿 변수맵 생성: #{학생명}은 학생 마스터에서, 나머지는 입력값에서. 누락 변수는 빈 문자열.
export function buildParentNoticeVariables(student, templateKey, input = {}) {
  const def = PARENT_NOTICE_TEMPLATES[templateKey];
  if (!def) return null;
  const vars = { '#{학생명}': String(student?.name ?? '') };
  for (const key of def.vars) vars[`#{${key}}`] = String(input?.[key] ?? '');
  return vars;
}

export async function handleSendParentNotice(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const studentId = String(data.studentId ?? '').trim();
  const templateKey = String(data.templateKey ?? '');
  const def = PARENT_NOTICE_TEMPLATES[templateKey];
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');
  if (!def) throw new HttpsError('invalid-argument', `알 수 없는 안내 템플릿입니다: ${templateKey}`);

  const templateCode = process.env[def.envKey];
  if (!templateCode) {
    throw new HttpsError('failed-precondition', `${def.label} 템플릿이 아직 승인/설정되지 않았습니다.`);
  }

  const snap = await db.collection('students').doc(studentId).get();
  if (!snap.exists) throw new HttpsError('not-found', '학생을 찾을 수 없습니다.');
  const student = snap.data();
  const phone = resolveRecipientPhone(student, data.recipientField);
  if (!phone) throw new HttpsError('failed-precondition', '선택한 대상의 연락처가 없습니다.');

  const variables = buildParentNoticeVariables(student, templateKey, data.variables);

  // 멱등: requestId 지정 시 큐 doc id로 선점 — 응답 타임아웃 후 재시도의 중복 발송 차단.
  const queueRef = data.requestId
    ? db.collection('message_queue').doc(String(data.requestId))
    : db.collection('message_queue').doc();
  if (data.requestId) {
    const existing = await queueRef.get();
    if (existing.exists) return { queued: true, duplicate: true, queueId: queueRef.id, template: def.label };
  }

  await queueRef.set({
    kind: 'parent_notice',
    student_id: studentId,
    recipient_phone: phone,
    template_code: templateCode,
    template_variables: variables,
    fallback_text: applyTemplate(def.fallback, variables),
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    source: 'manual',
    created_by: request.auth?.uid ?? null,
    created_at: FieldValue.serverTimestamp(),
  });

  return { queued: true, queueId: queueRef.id, template: def.label };
}
