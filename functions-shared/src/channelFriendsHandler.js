import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';

// 카카오 채널 친구(가입자) 명단. doc id = 정규화 전화번호.
// 솔라피가 친구 여부 사전조회를 주지 않으므로, 채널 관리자센터 친구목록을 업로드해 우리 DB로 관리한다.
const COLL = 'kakao_channel_friends';
const BATCH_LIMIT = 450; // Firestore batch 500 한도 여유

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');
const isValidPhone = (d) => d.length >= 9 && d.length <= 11;

// 전화번호가 채널 친구인지. dailyReportHandler가 발송 분기에 사용.
export async function isChannelFriend(db, phone) {
  const d = onlyDigits(phone);
  if (!d) return false;
  const snap = await db.collection(COLL).doc(d).get();
  return snap.exists;
}

// 친구목록 업로드 동기화 — 입력 번호 전체로 set 교체(빠진 번호 제거·새 번호 추가).
export async function handleSyncChannelFriends(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const raw = Array.isArray(data.phones) ? data.phones : String(data.phones ?? '').split(/[\n,]+/);
  const next = new Set(raw.map(onlyDigits).filter(isValidPhone));

  const existingSnap = await db.collection(COLL).get();
  const existing = new Set(existingSnap.docs.map((d) => d.id));

  // 빈/오류 업로드로 친구목록이 통째로 날아가 전원이 비친구로 분기되는 사고를 막는다.
  if (next.size === 0 && existing.size > 0 && data.confirmClear !== true) {
    throw new HttpsError('invalid-argument', '유효한 번호가 없습니다. 전체 비우려면 confirmClear=true가 필요합니다.');
  }

  const ops = [
    ...[...next].filter((d) => !existing.has(d)).map((id) => ({ type: 'set', id })),
    ...[...existing].filter((d) => !next.has(d)).map((id) => ({ type: 'delete', id })),
  ];
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + BATCH_LIMIT)) {
      const ref = db.collection(COLL).doc(op.id);
      if (op.type === 'set') batch.set(ref, { phone: op.id, updated_at: FieldValue.serverTimestamp() });
      else batch.delete(ref);
    }
    await batch.commit();
  }
  return {
    added: ops.filter((o) => o.type === 'set').length,
    removed: ops.filter((o) => o.type === 'delete').length,
    total: next.size,
  };
}

// 친구 전화번호 전체 조회 — DSC가 재원생 학부모와 대조해 미가입 명단을 만든다(학원 규모 전제).
export async function handleGetChannelFriends(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);
  const snap = await db.collection(COLL).get();
  return { phones: snap.docs.map((d) => d.id) };
}
