// 목적: contact-only 9건을 students에 status='상담'으로 backfill
// 특수 케이스: 김도영2는 기존 퇴원 students(김도영_2_) + contacts를 새 docId로 병합
// 실행: node _backfill_consult_students.cjs          → dry-run
//       node _backfill_consult_students.cjs --execute → 실제 실행

const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

const EXECUTE = process.argv.includes('--execute');

// 단순 backfill (contact 데이터 → students, status=상담, enrollments=[])
const SIMPLE_IDS = [
  '김예은_1082912365',
  '김형준_1041455781',
  '류영우_1032985072',
  '민주찬_1048608638',
  '안찬_1087659236',
  '이해든_1047888264',
  '채송이_1090308148',
  '채송희_1090308148',
];

// 특수 병합: 기존 퇴원 students 문서의 enrollments를 보존하면서 새 docId로 재생성
const MERGE_CASES = [
  {
    newStudentId: '김도영2_1043638213',
    oldStudentId: '김도영_2_1043638213',
    contactId: '김도영2_1043638213',
  },
];

function buildStudentDataFromContact(contact, existingEnrollments = []) {
  const data = {
    name: contact.name,
    status: '상담',
    enrollments: existingEnrollments || [],
  };
  // 필드가 있고 공란이 아니면만 포함 (rules: 있으면 비공란이어야 하는 필드가 있음)
  if (contact.school) data.school = contact.school;
  if (contact.grade != null && contact.grade !== '') data.grade = String(contact.grade);
  if (contact.level) data.level = contact.level;
  if (contact.parent_phone_1) data.parent_phone_1 = contact.parent_phone_1;
  if (contact.parent_phone_2) data.parent_phone_2 = contact.parent_phone_2;
  if (contact.student_phone) data.student_phone = contact.student_phone;
  if (contact.guardian_name_1) data.guardian_name_1 = contact.guardian_name_1;
  if (contact.guardian_name_2) data.guardian_name_2 = contact.guardian_name_2;
  if (contact.first_registered) data.first_registered = contact.first_registered;
  if (contact.branch) data.branch = contact.branch;
  return data;
}

function dump(label, data, indent = '    ') {
  if (!data) { console.log(`${indent}${label}: (없음)`); return; }
  console.log(`${indent}${label}:`);
  for (const k of Object.keys(data).sort()) {
    let v = data[k];
    if (typeof v === 'object' && v !== null) v = JSON.stringify(v);
    const s = String(v ?? '');
    console.log(`${indent}  ${k}: ${s.length > 180 ? s.slice(0, 180) + '…' : s}`);
  }
}

(async () => {
  console.log(`\n=== 모드: ${EXECUTE ? '★ 실제 실행 ★' : 'DRY-RUN (쓰기 없음)'} ===\n`);

  let totalCreated = 0;
  let totalDeleted = 0;
  let totalSkipped = 0;

  // ─── 단순 backfill 8건 ───────────────────────────────────────────────────
  console.log('─── [단순 backfill 8건] ───\n');
  for (const id of SIMPLE_IDS) {
    console.log(`[${id}]`);
    const [cSnap, sSnap] = await Promise.all([
      db.collection('contacts').doc(id).get(),
      db.collection('students').doc(id).get(),
    ]);

    if (!cSnap.exists) {
      console.log(`  ⚠️  contacts 문서 없음. 스킵.`);
      totalSkipped++;
      continue;
    }
    if (sSnap.exists) {
      console.log(`  ⚠️  students 문서가 이미 존재함. 스킵.`);
      totalSkipped++;
      continue;
    }

    const contact = cSnap.data();
    const studentData = buildStudentDataFromContact(contact, []);
    dump('생성할 students 데이터', studentData);

    if (EXECUTE) {
      await db.collection('students').doc(id).set(studentData);
      await db.collection('contacts').doc(id).delete();
      console.log(`  ✅ students/${id} 생성 + contacts/${id} 삭제`);
      totalCreated++;
      totalDeleted++;
    } else {
      console.log(`  [DRY-RUN] students/${id} 생성 예정 + contacts/${id} 삭제 예정`);
    }
    console.log('');
  }

  // ─── 특수 병합 1건 (김도영2) ─────────────────────────────────────────────
  console.log('─── [특수 병합: 김도영2] ───\n');
  for (const { newStudentId, oldStudentId, contactId } of MERGE_CASES) {
    console.log(`[new=${newStudentId}, old=${oldStudentId}, contact=${contactId}]`);

    const [cSnap, oldSSnap, newSSnap] = await Promise.all([
      db.collection('contacts').doc(contactId).get(),
      db.collection('students').doc(oldStudentId).get(),
      db.collection('students').doc(newStudentId).get(),
    ]);

    if (!cSnap.exists) { console.log(`  ⚠️  contacts/${contactId} 없음. 스킵.`); totalSkipped++; continue; }
    if (newSSnap.exists) { console.log(`  ⚠️  students/${newStudentId} 이미 존재. 스킵.`); totalSkipped++; continue; }
    if (!oldSSnap.exists) { console.log(`  ⚠️  students/${oldStudentId} 없음. 스킵.`); totalSkipped++; continue; }

    const contact = cSnap.data();
    const oldStudent = oldSSnap.data();
    dump('기존 퇴원 students (삭제될 것)', oldStudent);
    dump('contacts (삭제될 것)', contact);

    // 과거 enrollments에 end_date 채우기 (withdrawal_date 기준) — 종료된 이력으로 보존
    const endDate = oldStudent.withdrawal_date || '';
    const preservedEnrollments = (oldStudent.enrollments || []).map(e => {
      if (e.end_date) return e;  // 이미 end_date 있으면 유지
      return endDate ? { ...e, end_date: endDate } : e;
    });

    // 병합: contacts의 최신 정보 + 옛 student의 enrollments 이력 + branch 보존
    const mergedStudentData = buildStudentDataFromContact(contact, preservedEnrollments);
    mergedStudentData.name = contact.name;
    // branch는 contacts에 없으므로 old student에서 가져옴
    if (!mergedStudentData.branch && oldStudent.branch) {
      mergedStudentData.branch = oldStudent.branch;
    }
    dump('병합된 새 students 데이터', mergedStudentData);

    // 동일인 검증: 전화번호 일치
    const cPhone = (contact.parent_phone_1 || '').replace(/\D/g, '');
    const oPhones = [oldStudent.parent_phone_1, oldStudent.parent_phone_2]
      .filter(Boolean).map(p => p.replace(/\D/g, ''));
    const samePerson = oPhones.some(p => p === cPhone);
    console.log(`  동일인 검증: contacts 전화(${cPhone}) ∈ old students 전화(${oPhones.join(', ')}) → ${samePerson ? '✅' : '❌'}`);
    if (!samePerson) {
      console.log(`  ⚠️  동일인 아닐 수 있음. 수동 확인 필요. 스킵.`);
      totalSkipped++;
      continue;
    }

    if (EXECUTE) {
      await db.collection('students').doc(newStudentId).set(mergedStudentData);
      await db.collection('students').doc(oldStudentId).delete();
      await db.collection('contacts').doc(contactId).delete();
      console.log(`  ✅ students/${newStudentId} 생성`);
      console.log(`  ✅ students/${oldStudentId} 삭제 (퇴원 이력은 enrollments로 이관)`);
      console.log(`  ✅ contacts/${contactId} 삭제`);
      totalCreated++;
      totalDeleted += 2;
    } else {
      console.log(`  [DRY-RUN] students/${newStudentId} 생성 + ${oldStudentId} 삭제 + contacts/${contactId} 삭제 예정`);
    }
    console.log('');
  }

  console.log(`\n=== 요약: 생성 ${totalCreated}, 삭제 ${totalDeleted}, 스킵 ${totalSkipped} ===\n`);
  process.exit(0);
})();
