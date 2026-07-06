import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { applyTemplate, BRAND_PREFIX } from './templates.js';
import { resolveRecipientTarget, resolveRecipientTargets } from './recipientPhone.js';

// 개별 학부모 정보성 안내(알림톡) 발송 callable. 학생 상세 패널 '메시지' 탭에서 1건 발송.
// 정보성이므로 동의·야간 제한 없음. 승인된 알림톡 템플릿 코드는 .env로 주입(검수 승인 후 확정).
// 홍보(광고)는 별도 경로(createPromoCampaign) — 여기서 다루지 않는다.

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
  // 등하원 출입 알림(가장 빈번) — 시각만 변수. 메시지 탭 빠른 버튼에서 현재 시각으로 발송.
  arrival: {
    envKey: 'ARRIVAL_TEMPLATE_CODE',
    label: '등원 안내',
    vars: ['시각'],
    fallback: `${BRAND_PREFIX} 등원 안내\n#{학생명} 학생이 #{시각}에 등원하였습니다.\n문의: 02-2649-0509`,
  },
  departure: {
    envKey: 'DEPARTURE_TEMPLATE_CODE',
    label: '귀가 안내',
    vars: ['시각'],
    fallback: `${BRAND_PREFIX} 귀가 안내\n#{학생명} 학생이 #{시각}에 귀가하였습니다.\n문의: 02-2649-0509`,
  },
  out: {
    envKey: 'OUT_TEMPLATE_CODE',
    label: '외출 안내',
    vars: ['시각'],
    fallback: `${BRAND_PREFIX} 외출 안내\n#{학생명} 학생이 #{시각}에 외출하였습니다.\n문의: 02-2649-0509`,
  },
  return: {
    envKey: 'RETURN_TEMPLATE_CODE',
    label: '귀원 안내',
    vars: ['시각'],
    fallback: `${BRAND_PREFIX} 귀원 안내\n#{학생명} 학생이 #{시각}에 귀원하였습니다.\n문의: 02-2649-0509`,
  },
  // 지각 등원 — 등원 안내와 분리(태블릿 체크인이 late면 arrival 대신 이 템플릿으로 라우팅).
  late: {
    envKey: 'LATE_TEMPLATE_CODE',
    label: '지각 안내',
    vars: ['시각'],
    fallback: `${BRAND_PREFIX} 지각 안내\n#{학생명} 학생이 #{시각}에 지각 등원하였습니다.\n문의: 02-2649-0509`,
  },
  // 미등원(결석) 안내 — 등원예정 경과 + 미체크인 자동판정 스윕이 발송.
  absence: {
    envKey: 'ABSENCE_TEMPLATE_CODE',
    label: '미등원 안내',
    vars: ['일시'],
    fallback: `${BRAND_PREFIX} 미등원 안내\n#{학생명} 학생이 #{일시} 수업에 등원하지 않았습니다. 등원 예정이 아니라면 확인 부탁드립니다.\n문의: 02-2649-0509`,
  },
  // 과제·준비물·공지 범용 — 메시지 탭 수동 발송.
  study: {
    envKey: 'STUDY_TEMPLATE_CODE',
    label: '학습 안내',
    vars: ['안내내용'],
    fallback: `${BRAND_PREFIX} 학습 안내\n#{학생명} 학생 학부모님: #{안내내용}\n문의: 02-2649-0509`,
  },
  // 개별 보강 일정 — 메시지 탭 수동 발송.
  makeup: {
    envKey: 'MAKEUP_TEMPLATE_CODE',
    label: '보강 안내',
    vars: ['보강일시', '보강내용'],
    fallback: `${BRAND_PREFIX} 보강 안내\n#{학생명} 학생 보강 일정 — 일시: #{보강일시} / 내용: #{보강내용}\n문의: 02-2649-0509`,
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

function parentNoticeTargets(student, data) {
  const fields = Array.isArray(data.recipientFields) && data.recipientFields.length
    ? data.recipientFields
    : null;
  if (fields) return resolveRecipientTargets(student, fields);

  const target = resolveRecipientTarget(student, data.recipientField);
  return target ? [target] : [];
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
  const targets = parentNoticeTargets(student, data);
  if (!targets.length) throw new HttpsError('failed-precondition', '선택한 대상의 연락처가 없습니다.');

  const variables = buildParentNoticeVariables(student, templateKey, data.variables);

  const queueIds = [];
  let duplicates = 0;
  for (const target of targets) {
    const queueRef = data.requestId
      ? db.collection('message_queue').doc(targets.length === 1 ? String(data.requestId) : `${String(data.requestId)}_${target.field}`)
      : db.collection('message_queue').doc();
    if (data.requestId) {
      const existing = await queueRef.get();
      if (existing.exists) {
        duplicates += 1;
        queueIds.push(queueRef.id);
        continue;
      }
    }
    await queueRef.set({
      kind: 'parent_notice',
      student_id: studentId,
      recipient_role: target.field,
      recipient_phone: target.phone,
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
    queueIds.push(queueRef.id);
  }

  return {
    queued: queueIds.length > duplicates,
    duplicate: duplicates === targets.length,
    queueId: queueIds[0] ?? null,
    queueIds,
    queuedCount: queueIds.length - duplicates,
    duplicateCount: duplicates,
    template: def.label,
  };
}
