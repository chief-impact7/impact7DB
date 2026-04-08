const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const [studentsSnap, contactsSnap] = await Promise.all([
    db.collection('students').select().get(),
    db.collection('contacts').select().get(),
  ]);

  const studentIds = new Set(studentsSnap.docs.map(d => d.id));
  const contactIds = new Set(contactsSnap.docs.map(d => d.id));

  const onlyInContacts = [...contactIds].filter(id => !studentIds.has(id));
  const onlyInStudents = [...studentIds].filter(id => !contactIds.has(id));

  console.log(`students: ${studentIds.size}, contacts: ${contactIds.size}`);
  console.log(`\n=== contacts에만 있는 문서: ${onlyInContacts.length}건 ===`);
  for (const id of onlyInContacts.slice(0, 20)) {
    const doc = await db.collection('contacts').doc(id).get();
    const d = doc.data();
    console.log(`  ${id} — ${d.name || '?'}, ${d.school || ''}, ${d.grade || ''}`);
  }

  console.log(`\n=== students에만 있는 문서: ${onlyInStudents.length}건 ===`);
  for (const id of onlyInStudents.slice(0, 20)) {
    const doc = await db.collection('students').doc(id).get();
    const d = doc.data();
    console.log(`  ${id} — ${d.name || '?'}, ${d.status || ''}, ${d.school || ''}`);
  }

  process.exit(0);
})();
