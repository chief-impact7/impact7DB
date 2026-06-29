import admin from 'firebase-admin';
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-impact7' });
const db = admin.firestore();
async function seed() {
  const emp1 = {
    name: '김행정', phone: '01011112222', email: 'a@i.kr',
    residentNumber: '900101-1000000', birthDate: '1990-01-01', address: '서울',
    position: '교무', bankInfo: { bank: '우리', accountNumber: '111', holder: '김행정' },
    taxInfo: { taxType: '근로소득', dependents: 0, hasOtherIncome: false },
    documents: { idCopy: null, bankbook: null, resume: null, certificates: [] },
    status: 'active', joinDate: '2025-01-01', onboardingCompletedAt: null, memo: '',
  };
  const emp2 = {
    name: '이행정', phone: '01055556666', email: 'b@i.kr',
    residentNumber: '910202-2000000', birthDate: '1991-02-02', address: '서울',
    position: '데스크', bankInfo: { bank: '하나', accountNumber: '222', holder: '이행정' },
    taxInfo: { taxType: '근로소득', dependents: 1, hasOtherIncome: false },
    documents: { idCopy: null, bankbook: null, resume: null, certificates: [] },
    status: 'active', joinDate: '2025-03-01', onboardingCompletedAt: null, memo: '',
  };
  const st1 = {
    name: '박단기', phone: '01033334444', email: 'c@i.kr',
    residentNumber: '000101-3000000', address: '서울',
    bank: '하나', accountNumber: '999', accountHolder: '박단기',
    createdBy: 'seed', createdAt: admin.firestore.Timestamp.fromDate(new Date('2026-03-01')),
  };
  const teacher1 = {
    name: '정교수', phone: '01077778888', email: 't@i.kr',
    residentNumber: '850505-1000000', birthDate: '1985-05-05', address: '서울',
    subject: '수학', bankInfo: { bank: '우리', accountNumber: '777', holder: '정교수' },
    taxInfo: { taxType: '근로소득', dependents: 0, hasOtherIncome: false },
    documents: { idCopy: null, bankbook: null, resume: null, certificates: [], taxWithholdingConsent: null },
    staffType: 'teacher', status: 'active', joinDate: '2024-01-01', onboardingCompletedAt: null, memo: '',
  };
  await db.collection('employees').add(emp1);
  await db.collection('employees').add(emp2);
  await db.collection('shortTermStaff').add(st1);
  await db.collection('staff').add(teacher1);
  console.log('[seed] employees 2, shortTermStaff 1, 교사 1(dept 미설정) 삽입');
}
seed().catch(e => { console.error(e); process.exit(1); });
