import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';

// 학생 상세 '메시지' 탭의 발송 내역 조회. message_logs(최종 결과: sent/failed)를 학생별 최신순으로.
// 복합 인덱스 message_logs(student_id ASC, created_at DESC) 필요.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function toIso(ts) {
  if (ts?.toDate) return ts.toDate().toISOString();
  return typeof ts === 'string' ? ts : null;
}

// message_logs doc → 화면용 최소 형태(평문 번호 미포함, 마스킹만).
export function mapMessageLog(id, x) {
  return {
    id,
    kind: x.kind ?? null, // attendance | parent_notice | promo
    status: x.status ?? null, // sent | failed
    channel: x.channel ?? null, // kakao | sms | ...
    statusCode: x.status_code ?? null,
    errorMessage: x.error_message ?? null,
    templateCode: x.request_summary?.template_code ?? null,
    recipientMasked: x.request_summary?.recipient_masked ?? null,
    createdAt: toIso(x.created_at),
  };
}

export async function handleGetStudentMessages(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const studentId = String(request.data?.studentId ?? '').trim();
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');
  const limit = Math.min(Number(request.data?.limit) || DEFAULT_LIMIT, MAX_LIMIT);

  const snap = await db.collection('message_logs')
    .where('student_id', '==', studentId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get();

  return { items: snap.docs.map((d) => mapMessageLog(d.id, d.data())) };
}
