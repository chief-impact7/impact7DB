import { FieldValue } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';

// 카카오 채널 가입 유도 대상(비친구 확정 명단) — kakao_channel_friends와 대칭 컬렉션.
// 친구톡이 비친구(3120)로 문자 전환될 때 기록되고, 이후 친구톡 도달(=가입 확인) 시 자동 제거된다.
// 서버 전용(rules 기본 거부) — 클라에는 callable이 마스킹 번호 + 불투명 키만 내려준다.
// 키는 번호 해시가 아닌 랜덤값이다: 해시는 마스킹(뒤 4자리 노출)과 조합하면 브루트포스로
// 번호가 역산되어 평문 미반출 계약(§2.5)이 깨진다.

export const NONFRIEND_TARGETS_COLLECTION = 'kakao_nonfriend_targets';

const onlyDigits = (value) => String(value ?? '').replace(/\D/g, '');

// 비친구 확정(3120) 전환 시 upsert. 숨김(hidden_at)은 새 증거가 생기면 해제되어 다시 나타나고,
// 영구 제외(excluded)는 merge가 건드리지 않으므로 유지된다. 키는 최초 1회만 발급해 유지한다.
export async function recordNonFriendTarget(db, { phone, studentId = null, kind = null }) {
  const phoneKey = onlyDigits(phone);
  if (!phoneKey) return;
  const ref = db.collection(NONFRIEND_TARGETS_COLLECTION).doc(phoneKey);
  const snap = await ref.get();
  const patch = {
    phone: phoneKey,
    key: (snap.exists && snap.data()?.key) || randomBytes(16).toString('hex'),
    last_converted_at: FieldValue.serverTimestamp(),
    convert_count: FieldValue.increment(1),
    last_kind: kind,
    hidden_at: FieldValue.delete(),
    updated_at: FieldValue.serverTimestamp(),
  };
  if (studentId) patch.student_id = studentId;
  await ref.set(patch, { merge: true });
}

// 친구톡 도달 확정(=채널 가입 확인) 시 명단에서 자동 제거 — 유도가 성공하면 명단이 스스로 준다.
// 단 영구 제외 doc은 보존한다: 삭제하면 이후 재전환(3120) 때 excluded 없는 새 doc이 생겨
// 운영자의 "앞으로 유도 안 함" 결정과 감사 기록(excluded_by)이 소실된다.
export async function removeNonFriendTarget(db, phone) {
  const phoneKey = onlyDigits(phone);
  if (!phoneKey) return;
  const ref = db.collection(NONFRIEND_TARGETS_COLLECTION).doc(phoneKey);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.excluded === true) return;
  await ref.delete();
}
