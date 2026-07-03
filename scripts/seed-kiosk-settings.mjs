import admin from 'firebase-admin';

// 태블릿 조회 PIN 시드 — kiosk_settings/global (서버 전용, 클라 규칙 차단).
// 사용: node scripts/seed-kiosk-settings.mjs --pin 123456 --apply
const APPLY = process.argv.includes('--apply');
const pinIdx = process.argv.indexOf('--pin');
const PIN = pinIdx > -1 ? process.argv[pinIdx + 1] : '';

if (!/^\d{6}$/.test(PIN)) {
  console.error('[seed] --pin 6자리 숫자가 필요합니다. 예: --pin 123456');
  process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'impact7db' });
const db = admin.firestore();

const ref = db.collection('kiosk_settings').doc('global');
const snap = await ref.get();
console.log(`[seed] 현재 문서: ${snap.exists ? JSON.stringify({ ...snap.data(), admin_pin: '******' }) : '(없음)'}`);
if (!APPLY) {
  console.log('[seed] dry-run — --apply를 붙이면 admin_pin을 기록합니다.');
  process.exit(0);
}
await ref.set({ admin_pin: PIN, pin_fail_count: 0, pin_locked_until: 0, updated_at: new Date().toISOString() }, { merge: true });
console.log('[seed] kiosk_settings/global.admin_pin 기록 완료.');
