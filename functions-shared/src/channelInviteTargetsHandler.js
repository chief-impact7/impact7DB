import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { formatPhone } from '@impact7/shared/phone';
import { assertAuthorizedStaff } from './authGuards.js';
import { maskPhone } from './phoneMask.js';
import { tsToMillis } from './timestampUtil.js';
import { NONFRIEND_TARGETS_COLLECTION } from './nonFriendTargets.js';

// 채널 가입 유도 대상 명단 조회/관리 callable.
// 명단의 원천은 문자 전환 확정(3120) 시점의 워커 기록(nonFriendTargets.js) — 여기선 읽고 관리만 한다.
// 평문 번호는 반출하지 않는다: 표시용 마스킹 번호 + 조작용 불투명 키(랜덤)만 내려준다.

// 한계: 숨김·제외 doc도 이 창을 소비한다(결측 필드는 Firestore 쿼리로 못 거름). 명단이 수백 건
// 규모가 되면 active 필드 + 복합 인덱스로 서버 필터링 전환할 것(현재 수십 건 규모라 보류).
const LIST_LIMIT = 200;

// 재원생 매칭 — student_id가 있으면 그 학생, 없으면(신청자 등) 학부모 번호로 역조회.
// 번호 저장 형식이 혼재(하이픈 유무)하므로 두 형식 모두 시도한다(functions resolveStudentId와 동일 규칙).
async function resolveTargetName(db, target) {
  if (target.student_id) {
    try {
      const snap = await db.collection('students').doc(target.student_id).get();
      if (snap.exists) return { name: snap.data()?.name ?? '', matched: 'student', studentId: target.student_id };
    } catch { /* 조회 실패 시 번호 매칭으로 폴백 */ }
  }
  const digits = String(target.phone ?? '');
  const candidates = [...new Set([digits, formatPhone(digits)])].filter(Boolean);
  const probes = ['parent_phone_1', 'parent_phone_2']
    .flatMap((field) => candidates.map((value) => ({ field, value })));
  const results = await Promise.all(
    probes.map((p) => db.collection('students').where(p.field, '==', p.value).limit(1).get()),
  );
  const hit = results.find((q) => q.docs.length);
  if (hit) return { name: hit.docs[0].data()?.name ?? '', matched: 'student', studentId: hit.docs[0].id };
  return { name: '', matched: 'none', studentId: null };
}

// 명단 조회 — 기본은 활성(숨김·제외 아님)만. includeInactive면 숨김·제외도 플래그와 함께 내려
// 복원 UI를 지원한다. sinceMs로 기간 필터(최근 전환 기준).
export async function handleGetChannelInviteTargets(request, deps = {}) {
  assertAuthorizedStaff(request.auth);
  const db = deps.firestore ?? getFirestore();

  const sinceMs = Number(request.data?.sinceMs);
  const includeInactive = request.data?.includeInactive === true;

  let query = db.collection(NONFRIEND_TARGETS_COLLECTION).orderBy('last_converted_at', 'desc');
  if (Number.isFinite(sinceMs) && sinceMs > 0) {
    query = query.where('last_converted_at', '>=', new Date(sinceMs));
  }
  const snap = await query.limit(LIST_LIMIT).get();

  let hiddenCount = 0;
  let excludedCount = 0;
  const entries = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const excluded = d.excluded === true;
    const hidden = !excluded && d.hidden_at != null;
    if (excluded) excludedCount += 1;
    else if (hidden) hiddenCount += 1;
    if ((excluded || hidden) && !includeInactive) continue;
    entries.push({ d, hidden, excluded });
  }
  // 활성 우선 정렬(includeInactive 시 숨김·제외가 뒤로) — 쿼리 순서(최근 전환순)는 그 안에서 유지.
  entries.sort((a, b) => (a.hidden || a.excluded) - (b.hidden || b.excluded));

  // 이름 매칭은 행 단위로 병렬 실행 — 순차 N+1이면 목록이 커질수록 callable 타임아웃 위험.
  const targets = await Promise.all(entries.map(async ({ d, hidden, excluded }) => {
    const { name, matched, studentId } = await resolveTargetName(db, d);
    return {
      key: d.key,
      name,
      matched,
      studentId,
      masked: maskPhone(d.phone),
      count: d.convert_count ?? 1,
      lastConvertedAt: tsToMillis(d.last_converted_at),
      lastKind: d.last_kind ?? null,
      invitedAt: tsToMillis(d.invited_at),
      hidden,
      excluded,
    };
  }));

  return {
    targets,
    hiddenCount,
    excludedCount,
    limitReached: snap.docs.length >= LIST_LIMIT,
    generatedAt: Date.now(),
  };
}

const MANAGE_ACTIONS = new Set(['hide', 'exclude', 'invited', 'restore']);

// 명단 관리 — hide(숨김: 새 전환 발생 시 재등장) / exclude(영구 제외) /
// invited(유도 발송 표시) / restore(숨김·제외 해제). 직원 권한.
export async function handleManageChannelInviteTarget(request, deps = {}) {
  assertAuthorizedStaff(request.auth);
  const db = deps.firestore ?? getFirestore();

  const key = String(request.data?.key ?? '').trim();
  const action = String(request.data?.action ?? '');
  if (!key) throw new HttpsError('invalid-argument', 'key가 필요합니다.');
  if (!MANAGE_ACTIONS.has(action)) {
    throw new HttpsError('invalid-argument', 'action은 hide/exclude/invited/restore 중 하나여야 합니다.');
  }

  const snap = await db.collection(NONFRIEND_TARGETS_COLLECTION).where('key', '==', key).limit(1).get();
  if (!snap.docs.length) throw new HttpsError('not-found', '대상을 찾을 수 없습니다.');

  const email = request.auth.token?.email || '';
  const patch = {
    hide: { hidden_at: FieldValue.serverTimestamp(), hidden_by: email },
    exclude: { excluded: true, excluded_at: FieldValue.serverTimestamp(), excluded_by: email },
    invited: { invited_at: FieldValue.serverTimestamp(), invited_by: email },
    restore: {
      hidden_at: FieldValue.delete(),
      hidden_by: FieldValue.delete(),
      excluded: FieldValue.delete(),
      excluded_at: FieldValue.delete(),
      excluded_by: FieldValue.delete(),
    },
  }[action];

  await snap.docs[0].ref.update({ ...patch, updated_at: FieldValue.serverTimestamp() });
  return { ok: true, key, action };
}
