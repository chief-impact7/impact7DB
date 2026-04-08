const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

const deletedIds = [
  '김기문_1085882817', '김도영2_1043638213', '김예은_1082912365',
  '김형준_1041455781', '류영우_1032985072', '서윤하_1046206840',
  '안찬_1087659236', '이해든_1047888264', '정지우2_0109183302301054492023',
  '채송이_1090308148', '채송희_1090308148', '황시윤_1082646149'
];

(async () => {
  // 1) history_logs에서 이력 확인
  for (const id of deletedIds) {
    const logs = await db.collection('history_logs').where('doc_id', '==', id).limit(5).get();
    if (logs.empty) {
      console.log(`${id}: 이력 없음`);
    } else {
      logs.forEach(doc => {
        const d = doc.data();
        const ts = d.timestamp?.toDate?.() || '?';
        console.log(`${id}: ${d.change_type} by ${d.google_login_id} (${ts})`);
      });
    }
  }

  // 2) 3/6 백업에 있었는지 확인
  const backup = require('./backups/students_2026-03-06.json');
  console.log('\n=== 3/6 백업 존재 여부 ===');
  for (const id of deletedIds) {
    const b = backup[id];
    console.log(`${id}: ${b ? `있음 (${b.name}, ${b.status})` : '없음'}`);
  }

  process.exit(0);
})();
