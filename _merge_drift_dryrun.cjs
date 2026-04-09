// 목적: 정지우2 contacts 삭제 + 서윤하 students 병합 (dry-run/execute 모드)
// 실행: node _merge_drift_dryrun.cjs          → dry-run (아무것도 쓰지 않음)
//       node _merge_drift_dryrun.cjs --execute → 실제 실행

const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

const EXECUTE = process.argv.includes('--execute');

function dump(label, data) {
  if (!data) { console.log(`  ${label}: (없음)`); return; }
  console.log(`  ${label}:`);
  for (const k of Object.keys(data).sort()) {
    let v = data[k];
    if (typeof v === 'object' && v !== null) v = JSON.stringify(v);
    const s = String(v ?? '');
    console.log(`    ${k}: ${s.length > 150 ? s.slice(0, 150) + '…' : s}`);
  }
}

(async () => {
  console.log(`\n=== 모드: ${EXECUTE ? '★ 실제 실행 ★' : 'DRY-RUN (쓰기 없음)'} ===\n`);

  // ─── 1. 정지우2 contacts 삭제 ──────────────────────────────────────────
  console.log('─── [1] 정지우2 contacts 삭제 ───');
  const jungId = '정지우2_0109183302301054492023';
  const jungContactRef = db.collection('contacts').doc(jungId);
  const jungContactSnap = await jungContactRef.get();
  if (!jungContactSnap.exists) {
    console.log(`  [SKIP] contacts/${jungId} 이미 없음`);
  } else {
    dump('삭제할 contacts 문서', jungContactSnap.data());
    // 정상 students 존재 확인
    const jungStudent = await db.collection('students').doc('정지우2_1091833023').get();
    if (!jungStudent.exists) {
      console.log(`  ⚠️ 경고: students/정지우2_1091833023 이 존재하지 않음! 중단`);
      process.exit(1);
    }
    console.log(`  ✓ 정상 students/정지우2_1091833023 존재 확인 (status=${jungStudent.data().status})`);
    if (EXECUTE) {
      await jungContactRef.delete();
      console.log(`  ✅ contacts/${jungId} 삭제 완료`);
    } else {
      console.log(`  [DRY-RUN] contacts/${jungId} 삭제 예정`);
    }
  }

  // ─── 2. 서윤하 병합 ──────────────────────────────────────────────────
  console.log('\n─── [2] 서윤하 병합 ───');
  const seoStudentId = '서윤하_1056946840';  // 기존 재원 (이전 전화번호 기준 docId)
  const seoContactId = '서윤하_1046206840';  // 신규 contacts (새 전화번호 기준 docId)
  const seoStudentRef = db.collection('students').doc(seoStudentId);
  const seoContactRef = db.collection('contacts').doc(seoContactId);
  const [seoStudentSnap, seoContactSnap] = await Promise.all([
    seoStudentRef.get(), seoContactRef.get(),
  ]);

  if (!seoStudentSnap.exists || !seoContactSnap.exists) {
    console.log(`  ⚠️ 한쪽 문서가 없음. students.exists=${seoStudentSnap.exists}, contacts.exists=${seoContactSnap.exists}`);
    process.exit(1);
  }

  const seoStudent = seoStudentSnap.data();
  const seoContact = seoContactSnap.data();
  dump('기존 students (유지 대상)', seoStudent);
  dump('contacts (새 정보, 삭제 예정)', seoContact);

  // 병합 정책 (수정됨): students가 이미 완전한 정보(parent_phone_2에 contacts 전화 존재) 보유.
  // → students는 기본 유지, contacts에만 있는 고유 정보(first_registered)만 보강 후 contacts 삭제.
  const merged = {};
  if (!seoStudent.first_registered && seoContact.first_registered) {
    merged.first_registered = seoContact.first_registered;
  }

  // 동일인 검증 확인 (contacts 전화가 students의 parent_phone_1 또는 parent_phone_2에 있어야 안전)
  const cPhone = (seoContact.parent_phone_1 || '').replace(/\D/g, '');
  const sPhones = [seoStudent.parent_phone_1, seoStudent.parent_phone_2]
    .filter(Boolean).map(p => p.replace(/\D/g, ''));
  const samePerson = sPhones.some(p => p === cPhone);
  console.log(`\n  동일인 검증: contacts 전화(${cPhone}) ∈ students 전화목록(${sPhones.join(', ')}) → ${samePerson ? '✅ 일치' : '❌ 불일치'}`);
  if (!samePerson) {
    console.log(`  ⚠️ 동일인이 아닐 수 있음. 수동 확인 필요 — 중단`);
    process.exit(1);
  }

  console.log('\n  students 업데이트할 필드:');
  if (Object.keys(merged).length === 0) {
    console.log('    (없음 — students가 이미 우월)');
  } else {
    for (const [k, v] of Object.entries(merged)) {
      const old = seoStudent[k];
      console.log(`    🔄 ${k}: ${String(old ?? '')} → ${String(v ?? '')}`);
    }
  }

  if (EXECUTE) {
    if (Object.keys(merged).length > 0) {
      await seoStudentRef.update(merged);
      console.log(`  ✅ students/${seoStudentId} 업데이트 완료`);
    } else {
      console.log(`  (students 업데이트 생략)`);
    }
    await seoContactRef.delete();
    console.log(`  ✅ contacts/${seoContactId} 삭제 완료`);
  } else {
    if (Object.keys(merged).length > 0) {
      console.log(`  [DRY-RUN] students/${seoStudentId} 업데이트 예정`);
    }
    console.log(`  [DRY-RUN] contacts/${seoContactId} 삭제 예정`);
  }

  console.log('\n=== 완료 ===\n');
  process.exit(0);
})();
