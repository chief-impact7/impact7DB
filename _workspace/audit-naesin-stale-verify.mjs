import admin from 'firebase-admin';
import { currentSchool, SCHOOL_FIELD } from '@impact7/shared/student-label';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname,'..','service-account.json'),'utf8'))), projectId:'impact7db' });
const db = admin.firestore();
const LEVEL_SHORT={'초등':'초','중등':'중','고등':'고'};
function regOf(s){return (s.enrollments||[]).find(e=>(e.class_type==='정규'||e.class_type==='자유학기')&&e.class_number)||(s.enrollments||[]).find(e=>(e.class_type==='정규'||e.class_type==='자유학기'));}
function branch(s){if(s.branch)return s.branch;const r=(s.enrollments||[]).find(e=>e.class_type==='정규'||e.class_type==='자유학기');const f=(r?.class_number||'').trim()[0];return f==='1'?'2단지':f==='2'?'10단지':'';}
function grp(s,e){const cn=e.class_number||'';const lc=cn.slice(-1).toUpperCase();let g=(lc==='A'||lc==='B')?lc:'';if(!g){const d=parseInt(lc);if(!isNaN(d))g=d%2?'A':'B';}if(!g){const r=(s.enrollments||[]).find(x=>(x.class_type==='정규'||x.class_type==='자유학기')&&x.class_number);if(r){const rr=parseInt((r.class_number||'').slice(-1));if(!isNaN(rr))g=rr%2?'A':'B';}}return g;}
function key(s,school){const r=regOf(s);if(!r)return null;const o=r.naesin_class_override;if(typeof o==='string')return o===''?null:o;const ls=LEVEL_SHORT[s.level]||'';const gr=s.grade||'';if(!school||!gr)return null;return branch(s)+`${school}${ls}${gr}${grp(s,r)}`;}

const snap=await db.collection('students').get();
const statusDist={};
let activeMismatch=[]; // 재원/등원예정인데 .school!=currentSchool 또는 누락 (내신 대상 여부 무관)
const sampleKept=[];
snap.forEach(d=>{const x=d.data();const f=SCHOOL_FIELD[x.level];const cs=currentSchool(x);const ds=x.school||'';const miss=!!f&&!x[f];const mis=ds!==cs;const stale=mis||miss;
  if(stale){statusDist[x.status||'(없음)']=(statusDist[x.status||'(없음)']||0)+1;
    if(x.status==='재원'||x.status==='등원예정')activeMismatch.push({name:x.name,level:x.level,status:x.status,school:ds,cur:cs,miss,enr:(x.enrollments||[]).map(e=>e.class_type)});}
  // 활성 내신 키 보존 표본
  if((x.status==='재원'||x.status==='등원예정')&&!stale&&regOf(x)&&sampleKept.length<3){const ok=key(x,ds),nk=key(x,cs);if(ok)sampleKept.push({name:x.name,school:ds,cur:cs,ok,nk,same:ok===nk});}
});
console.log('전체 stale status 분포:',JSON.stringify(statusDist,null,2));
console.log('\n활성(재원/등원예정) stale 건수:',activeMismatch.length);
activeMismatch.slice(0,20).forEach(r=>console.log(`  ${r.name} [${r.level}/${r.status}] school="${r.school}" cur="${r.cur}" miss=${r.miss} enr=${r.enr}`));
console.log('\n활성 내신 키보존 표본(same=old==new):');
sampleKept.forEach(r=>console.log(`  ${r.name}: school="${r.school}"==cur="${r.cur}" key="${r.ok}" same=${r.same}`));
process.exit(0);
