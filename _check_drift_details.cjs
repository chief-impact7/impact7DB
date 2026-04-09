const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

const CONTACT_ONLY_IDS = [
  '김도영2_1043638213',
  '김예은_1082912365',
  '김형준_1041455781',
  '류영우_1032985072',
  '민주찬_1048608638',
  '서윤하_1046206840',
  '안찬_1087659236',
  '이해든_1047888264',
  '정지우2_0109183302301054492023',
  '채송이_1090308148',
  '채송희_1090308148',
];

const STUDENT_ONLY_IDS = [
  '선아인_1056345263',
];

function fmt(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function dumpDoc(label, data) {
  if (!data) { console.log(`  (문서 없음)`); return; }
  const keys = Object.keys(data).sort();
  for (const k of keys) {
    const val = fmt(data[k]);
    const truncated = val.length > 200 ? val.slice(0, 200) + '…' : val;
    console.log(`    ${k}: ${truncated}`);
  }
}

(async () => {
  console.log('========== contacts-only 11건 ==========\n');
  for (const id of CONTACT_ONLY_IDS) {
    const [cSnap, sSnap] = await Promise.all([
      db.collection('contacts').doc(id).get(),
      db.collection('students').doc(id).get(),
    ]);
    console.log(`\n[${id}]`);
    console.log(`  students 존재: ${sSnap.exists}`);
    console.log(`  contacts 존재: ${cSnap.exists}`);
    if (cSnap.exists) {
      console.log(`  --- contacts 필드 ---`);
      dumpDoc('contacts', cSnap.data());
    }
    // 같은 이름으로 students에 다른 docId로 있는지 확인
    const name = cSnap.data()?.name;
    if (name) {
      const nameSearch = await db.collection('students').where('name', '==', name).get();
      if (!nameSearch.empty) {
        console.log(`  --- 동일 이름 students 검색: ${nameSearch.size}건 ---`);
        nameSearch.forEach(d => {
          const s = d.data();
          console.log(`    [${d.id}] status=${s.status||''}, school=${s.school||''}, grade=${s.grade||''}, parent_phone_1=${s.parent_phone_1||''}`);
        });
      } else {
        console.log(`  --- 동일 이름 students 검색: 없음 ---`);
      }
    }
  }

  console.log('\n\n========== students-only 1건 ==========\n');
  for (const id of STUDENT_ONLY_IDS) {
    const [cSnap, sSnap] = await Promise.all([
      db.collection('contacts').doc(id).get(),
      db.collection('students').doc(id).get(),
    ]);
    console.log(`\n[${id}]`);
    console.log(`  students 존재: ${sSnap.exists}`);
    console.log(`  contacts 존재: ${cSnap.exists}`);
    if (sSnap.exists) {
      console.log(`  --- students 필드 ---`);
      dumpDoc('students', sSnap.data());
    }
    const name = sSnap.data()?.name;
    if (name) {
      const nameSearch = await db.collection('contacts').where('name', '==', name).get();
      if (!nameSearch.empty) {
        console.log(`  --- 동일 이름 contacts 검색: ${nameSearch.size}건 ---`);
        nameSearch.forEach(d => {
          const c = d.data();
          console.log(`    [${d.id}] school=${c.school||''}, grade=${c.grade||''}, parent_phone_1=${c.parent_phone_1||''}`);
        });
      } else {
        console.log(`  --- 동일 이름 contacts 검색: 없음 ---`);
      }
    }
  }

  process.exit(0);
})();
