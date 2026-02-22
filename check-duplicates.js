/**
 * check-duplicates.js
 * Firestore students 컬렉션에서 중복 데이터를 찾아 리포트합니다.
 * 실행: node check-duplicates.js
 */

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const firebaseConfig = {
    apiKey:            "AIzaSyCb2DKuKVjYevqDlmeL3qa07jSE5azm8Nw",
    authDomain:        "impact7db.firebaseapp.com",
    projectId:         "impact7db",
    storageBucket:     "impact7db.firebasestorage.app",
    messagingSenderId: "485669859162",
    appId:             "1:485669859162:web:2cfe866520c0b8f3f74d63"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const snapshot = await getDocs(collection(db, 'students'));
const docs = snapshot.docs.map(d => ({ docId: d.id, ...d.data() }));

console.log(`\n총 Firestore 문서 수: ${docs.length}\n`);

// 1) 이름 기준 중복 확인
const byName = {};
docs.forEach(d => {
    const key = d.name || '(이름없음)';
    if (!byName[key]) byName[key] = [];
    byName[key].push(d);
});

const nameDups = Object.entries(byName).filter(([, arr]) => arr.length > 1);
console.log(`▶ 이름 중복: ${nameDups.length}건`);
nameDups.forEach(([name, arr]) => {
    console.log(`  "${name}" → ${arr.length}개 문서`);
    arr.forEach(d => console.log(`    docId: ${d.docId} | student_id: ${d.student_id} | 반: ${(d.level_code||'')+(d.level_symbol||'')} | branch: ${d.branch}`));
});

// 2) student_id 기준 중복 확인 (docId와 다른 경우)
const byStudentId = {};
docs.forEach(d => {
    const key = d.student_id || '(없음)';
    if (!byStudentId[key]) byStudentId[key] = [];
    byStudentId[key].push(d);
});

const idDups = Object.entries(byStudentId).filter(([, arr]) => arr.length > 1);
console.log(`\n▶ student_id 중복: ${idDups.length}건`);
idDups.forEach(([sid, arr]) => {
    console.log(`  student_id: "${sid}" → ${arr.length}개 문서`);
    arr.forEach(d => console.log(`    docId: ${d.docId} | 이름: ${d.name}`));
});

// 3) docId ≠ student_id 불일치 확인
const mismatch = docs.filter(d => d.student_id && d.docId !== d.student_id);
console.log(`\n▶ docId ≠ student_id 불일치: ${mismatch.length}건`);
mismatch.slice(0, 10).forEach(d =>
    console.log(`  docId: "${d.docId}" | student_id: "${d.student_id}" | 이름: ${d.name}`)
);
if (mismatch.length > 10) console.log(`  ... 외 ${mismatch.length - 10}건`);

process.exit(0);
