import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { applyTemplate, BRAND_PREFIX } from './templates.js';
import { resolveRecipientTarget, resolveRecipientTargets } from './recipientPhone.js';
import { getApprovedAlimtalkTemplate } from './alimtalkTemplateHandler.js';
import { buildAlimtalkOrSplitSmsDocs } from './bulkMessageHandler.js';
import { hashRequestFingerprint } from './requestFingerprint.js';

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
  rearrival: {
    envKey: 'REARRIVAL_TEMPLATE_CODE',
    label: '재등원 안내',
    vars: ['시각'],
    fallback: `${BRAND_PREFIX} 재등원 안내\n#{학생명} 학생이 #{시각}에 재등원하였습니다.\n문의: 02-2649-0509`,
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
  // 등원 예정 안내 — 보충/클리닉/재시/대체수업/수능인덱스 등 정규 외 등원을 사전 고지. 메시지 탭 수동 발송.
  arrival_plan: {
    envKey: 'ARRIVAL_PLAN_TEMPLATE_CODE',
    label: '등원 예정 안내',
    vars: ['일시', '사유'],
    fallback: `${BRAND_PREFIX} 등원 예정 안내\n#{학생명} 학생 등원 예정 — 일시: #{일시} / 사유: #{사유}\n시간에 늦지 않게 등원 부탁드립니다.\n문의: 02-2649-0509`,
  },
  // 미등원(결석) 안내 — 등원예정 경과 + 미체크인 자동판정 스윕이 발송.
  absence: {
    envKey: 'ABSENCE_TEMPLATE_CODE',
    label: '미등원 안내',
    vars: ['일시'],
    fallback: `${BRAND_PREFIX} 미등원 안내\n#{학생명} 학생이 #{일시} 수업에 등원하지 않았습니다. 등원 예정이 아니라면 확인 부탁드립니다.\n문의: 02-2649-0509`,
  },
  report: {
    envKey: 'REPORT_TEMPLATE_CODE',
    label: '수업 리포트',
    vars: ['날짜', '내용'],
    fallback: `${BRAND_PREFIX} 수업 리포트\n#{학생명} 학생의 #{날짜} 수업 결과를 안내드립니다.\n\n#{내용}\n\n재원생 학부모님께 수업 결과를 안내하는 정보성 메시지입니다.\n문의: 02-2649-0509`,
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
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(String(data.reportDate ?? ''))
    ? String(data.reportDate)
    : null;
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
  let alimtalkTemplate = { templateId: templateCode, content: def.fallback };
  if (!templateCode.endsWith('_PENDING')) {
    try {
      alimtalkTemplate = await (deps.getAlimtalkTemplate ?? getApprovedAlimtalkTemplate)(templateCode);
    } catch (error) {
      if (error?.code !== 'failed-precondition') throw error;
    }
  }
  const fallbackText = applyTemplate(def.fallback, variables);
  const deliveries = targets.map((target) => ({
    target,
    docs: buildAlimtalkOrSplitSmsDocs({
      phone: target.phone,
      template: alimtalkTemplate,
      variables,
      fallbackText,
      splitLongMessage: data.splitLongMessage === true,
      splitGroupId: data.requestId ? `parent:${data.requestId}:${studentId}:${target.field}` : null,
      createdBy: request.auth?.uid ?? null,
    }),
  }));
  const requestFingerprint = hashRequestFingerprint([
    studentId,
    templateKey,
    variables,
    targets.map((target) => target.field),
    reportDate,
    data.splitLongMessage === true,
  ]);

  const entries = deliveries.flatMap(({ target, docs }) => (
    docs.map((delivery, index) => {
      const isSplit = docs.length > 1;
      const requestDocId = data.requestId
        ? (isSplit
          ? `parent_${String(data.requestId)}_${target.field}_${index + 1}`
          : `parent_${String(data.requestId)}${targets.length === 1 ? '' : `_${target.field}`}`)
        : null;
      const queueRef = requestDocId
        ? db.collection('message_queue').doc(requestDocId)
        : db.collection('message_queue').doc();
      const convertedToSms = delivery.fallback_from_alimtalk === true;
      return {
        ref: queueRef,
        payload: {
          ...delivery,
          kind: convertedToSms ? 'direct' : 'parent_notice',
          student_id: studentId,
          template_key: templateKey,
          ...(reportDate ? { report_date_kst: reportDate } : {}),
          recipient_role: target.field,
          recipient_phone: target.phone,
          source: convertedToSms ? 'parent_notice_split_sms' : 'manual',
          request_fingerprint: requestFingerprint,
          created_by: request.auth?.uid ?? null,
          created_at: FieldValue.serverTimestamp(),
        },
      };
    })
  ));
  const sentinelRef = data.requestId
    ? db.collection('message_request_batches').doc(`parent_${String(data.requestId)}`)
    : null;
  const existing = sentinelRef ? await sentinelRef.get() : null;
  if (existing?.exists && existing.data()?.request_fingerprint !== requestFingerprint) {
    throw new HttpsError('invalid-argument', '같은 요청 ID의 발송 내용 또는 수신 대상이 이전 요청과 다릅니다.');
  }
  const legacyRefs = !existing?.exists && data.requestId
    ? targets.map((target) => db.collection('message_queue').doc(
      targets.length === 1 ? String(data.requestId) : `${String(data.requestId)}_${target.field}`,
    ))
    : [];
  const legacyStates = await Promise.all(legacyRefs.map(async (ref, index) => ({
    ref,
    field: targets[index].field,
    exists: (await ref.get()).exists,
  })));
  const existingLegacy = legacyStates.filter((state) => state.exists);
  if (legacyStates.length && existingLegacy.length === legacyStates.length) {
    const legacyQueueIds = existingLegacy.map(({ ref }) => ref.id);
    return {
      queued: false,
      duplicate: true,
      queueId: legacyQueueIds[0] ?? null,
      queueIds: legacyQueueIds,
      queuedCount: 0,
      duplicateCount: legacyQueueIds.length,
      template: def.label,
      channel: 'alimtalk',
      splitParts: 1,
    };
  }
  const existingLegacyFields = new Set(existingLegacy.map(({ field }) => field));
  const entriesToCreate = existingLegacy.length
    ? entries.filter(({ payload }) => !existingLegacyFields.has(payload.recipient_role))
    : entries;

  let duplicate = !!existing?.exists;
  if (!duplicate) {
    const batch = db.batch();
    if (sentinelRef) {
      batch.create(sentinelRef, {
        request_fingerprint: requestFingerprint,
        queue_count: existingLegacy.length + entriesToCreate.length,
        created_at: FieldValue.serverTimestamp(),
      });
    }
    for (const { ref, payload } of entriesToCreate) {
      if (sentinelRef) batch.create(ref, payload);
      else batch.set(ref, payload);
    }
    try {
      await batch.commit();
    } catch (e) {
      if (!(sentinelRef && (e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message))))) throw e;
      const raced = await sentinelRef.get();
      if (raced.data()?.request_fingerprint !== requestFingerprint) {
        throw new HttpsError('invalid-argument', '같은 요청 ID의 발송 내용 또는 수신 대상이 이전 요청과 다릅니다.');
      }
      duplicate = true;
    }
  }

  const convertedToSms = deliveries.some((delivery) => delivery.docs[0]?.fallback_from_alimtalk);
  const queueIds = [
    ...existingLegacy.map(({ ref }) => ref.id),
    ...entriesToCreate.map(({ ref }) => ref.id),
  ];
  return {
    queued: !duplicate,
    duplicate,
    queueId: queueIds[0] ?? null,
    queueIds,
    queuedCount: duplicate ? 0 : entriesToCreate.length,
    duplicateCount: duplicate ? queueIds.length : existingLegacy.length,
    template: def.label,
    channel: convertedToSms ? 'sms' : 'alimtalk',
    splitParts: convertedToSms ? deliveries[0].docs.length : 1,
  };
}
