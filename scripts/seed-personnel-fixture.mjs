import admin from 'firebase-admin';
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-impact7' });
const db = admin.firestore();
async function seed() {
  await db.collection('employees').add({ name:'김행정', phone:'01011112222', email:'a@i.kr', residentNumber:'900101-1000000', birthDate:'1990-01-01', address:'서울', position:'교무', bankInfo:{bank:'우리',accountNumber:'111',holder:'김행정'}, taxInfo:{taxType:'근로소득',dependents:0,hasOtherIncome:false}, documents:{idCopy:null,bankbook:null,resume:null,certificates:[]}, status:'active', joinDate:'2025-01-01', onboardingCompletedAt:null, memo:'' });
  await db.collection('employees').add({ name:'이행정', phone:'01055556666', email:'b@i.kr', residentNumber:'910202-2000000', birthDate:'1991-02-02', address:'서울', position:'데스크', bankInfo:{bank:'하나',accountNumber:'222',holder:'이행정'}, taxInfo:{taxType:'근로소득',dependents:1,hasOtherIncome:false}, documents:{idCopy:null,bankbook:null,resume:null,certificates:[]}, status:'active', joinDate:'2025-03-01', onboardingCompletedAt:null, memo:'' });
  await db.collection('shortTermStaff').add({ name:'박단기', phone:'01033334444', email:'c@i.kr', residentNumber:'000101-3000000', address:'서울', bank:'하나', accountNumber:'999', accountHolder:'박단기', createdBy:'seed', createdAt: admin.firestore.Timestamp.fromDate(new Date('2026-03-01')) });
  console.log('[seed] employees 2, shortTermStaff 1 삽입');
}
seed().catch(e => { console.error(e); process.exit(1); });
