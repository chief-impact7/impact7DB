import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { SolapiMessageService } from 'solapi';
import { promoConsentField } from './promoConsent.js';

// 솔라피 080 수신거부(getBlacks) 명단 → students.message_consent 동기화 스윕.
// 학부모가 080-500-4233에 전화하면 솔라피 계정 수신거부 명단에 등록되는데, 솔라피는 발송
// 단계에서만 차단하므로 우리 DB의 동의 기록·상세패널 표시와 어긋난다. 이 스윕이 명단을
// 당겨와 번호 주인 단위로 철회(source='optout_080')를 기록한다.
//
// 보수적 매핑: 학생 번호 → 학생 동의(promo_student), 학부모1/2·기타 번호 → 보호자 동의(promo).
// 보호자 동의 필드는 하나라 학부모2 번호가 거부해도 보호자 전체를 철회한다(과차단이 안전).
// 재동의는 상세패널 [동의] 버튼으로 기록 — source가 'optout_080'이 아니게 되므로 이 스윕이
// 명단에 남아 있는 한 다음 회차에 다시 철회한다(솔라피 명단에서도 지워야 재동의가 유지됨).

const PHONE_FIELD_TARGET = {
  student_phone: 'student',
  parent_phone_1: 'parent',
  parent_phone_2: 'parent',
  other_phone: 'parent',
};
const OPTOUT_SOURCE = 'optout_080';
const PAGE_LIMIT = 500;

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');

// 솔라피 080 수신거부 번호 전체 수집(페이지네이션).
async function defaultLoadBlacks() {
  const svc = new SolapiMessageService(process.env.SOLAPI_API_KEY, process.env.SOLAPI_API_SECRET);
  const out = new Set();
  let startKey = null;
  // page cap = 무한루프 방어(API가 같은 nextKey를 반복 반환하는 이상 케이스) — 500×40=2만 번호면 충분.
  for (let page = 0; page < 40; page += 1) {
    const res = await svc.getBlacks(startKey ? { startKey, limit: PAGE_LIMIT } : { limit: PAGE_LIMIT });
    for (const b of res.blackList ?? []) {
      const d = onlyDigits(b.recipientNumber);
      if (d) out.add(d);
    }
    const next = res.nextKey || null;
    if (!next || next === startKey) break;
    startKey = next;
  }
  return out;
}

export async function runOptOut080Sync(deps = {}) {
  const db = deps.db ?? getFirestore();
  const loadBlacks = deps.loadBlacks ?? defaultLoadBlacks;

  const blocked = await loadBlacks();
  if (blocked.size === 0) return { blocked: 0, revoked: 0, scanned: 0 };

  // 학원 규모(수백 명) 전제의 전수 스캔 — 번호 저장 포맷(하이픈 유무)과 무관하게 매칭한다.
  const snap = await db.collection('students').get();
  let revoked = 0;
  const writes = [];
  for (const doc of snap.docs) {
    const s = doc.data();
    const mc = s.message_consent ?? {};
    const patch = {};
    for (const [phoneField, target] of Object.entries(PHONE_FIELD_TARGET)) {
      const digits = onlyDigits(s[phoneField]);
      if (!digits || !blocked.has(digits)) continue;
      const consentField = promoConsentField(target);
      const cur = mc[consentField];
      // 이미 이 스윕이 철회했으면 재기록하지 않는다(멱등). 사용자가 재동의한 경우(source 변경)는
      // 명단에 남아 있는 한 다시 철회 — 법적 옵트아웃이 우선한다.
      if (cur && cur.optedIn === false && cur.source === OPTOUT_SOURCE) continue;
      patch[consentField] = {
        optedIn: false,
        source: OPTOUT_SOURCE,
        at: FieldValue.serverTimestamp(),
        revokedAt: FieldValue.serverTimestamp(),
      };
    }
    if (Object.keys(patch).length) {
      revoked += Object.keys(patch).length;
      // updated_at 갱신 — 클라 증분 동기화(updated_at 델타)가 철회를 놓치지 않게 한다.
      writes.push(doc.ref.set({ message_consent: patch, updated_at: FieldValue.serverTimestamp() }, { merge: true }));
    }
  }
  await Promise.all(writes);
  if (revoked > 0) console.log(`[optOut080Sync] 080 수신거부 ${blocked.size}번호 → 철회 기록 ${revoked}건`);
  return { blocked: blocked.size, revoked, scanned: snap.size };
}
