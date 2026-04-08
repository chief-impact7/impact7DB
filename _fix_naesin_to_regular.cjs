const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const snap = await db.collection('students').get();
  const batch = db.batch();
  let count = 0;

  snap.forEach(doc => {
    const d = doc.data();
    const enrollments = d.enrollments || [];
    let changed = false;
    const updated = enrollments.map(e => {
      if (e.class_type === '내신') {
        changed = true;
        return { ...e, class_type: '정규' };
      }
      return e;
    });

    if (changed) {
      batch.update(doc.ref, { enrollments: updated });
      count++;
      console.log(`  [내신→정규] ${doc.id} (${d.name})`);
    }
  });

  // 김지후 대일고3: semester만 있는 enrollment에 class_type 추가
  const jihuRef = db.collection('students').doc('김지후_0107658688501090944944');
  const jihuDoc = await jihuRef.get();
  const jihuEnroll = jihuDoc.data().enrollments || [];
  const jihuUpdated = jihuEnroll.map(e => {
    if (!e.class_type) {
      return { ...e, class_type: '정규' };
    }
    return e;
  });
  batch.update(jihuRef, { enrollments: jihuUpdated });
  count++;
  console.log(`  [class_type 추가] 김지후_0107658688501090944944 (김지후 대일고3)`);

  console.log(`\nCommitting ${count} updates...`);
  await batch.commit();
  console.log('Done!');
  process.exit(0);
})();
