/**
 * dedup-students.js
 * docId ≠ student_id인 중복 문서를 삭제합니다.
 * (올바른 문서: docId === student_id)
 * 실행: node dedup-students.js
 */

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, writeBatch, doc } from 'firebase/firestore';

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

console.log('Firestore에서 students 컬렉션 로딩 중...');
const snapshot = await getDocs(collection(db, 'students'));
const allDocs = snapshot.docs.map(d => ({ docId: d.id, ref: d.ref, ...d.data() }));

console.log(`총 문서 수: ${allDocs.length}`);

// 삭제 대상: docId가 student_id와 일치하지 않는 문서 (auto-generated ID)
const toDelete = allDocs.filter(d => d.student_id && d.docId !== d.student_id);

console.log(`삭제 대상: ${toDelete.length}개 (auto-ID 중복 문서)`);
console.log(`유지 대상: ${allDocs.length - toDelete.length}개\n`);

if (toDelete.length === 0) {
    console.log('중복 없음 — 정리 불필요');
    process.exit(0);
}

// 배치 삭제 (최대 499개씩)
const BATCH_SIZE = 499;
let deleted = 0;

for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const chunk = toDelete.slice(i, i + BATCH_SIZE);
    const batch = writeBatch(db);
    chunk.forEach(d => batch.delete(doc(db, 'students', d.docId)));
    await batch.commit();
    deleted += chunk.length;
    console.log(`  삭제 완료: ${deleted}/${toDelete.length}`);
}

console.log(`\n✅ 정리 완료. 남은 문서: ${allDocs.length - deleted}개`);
process.exit(0);
