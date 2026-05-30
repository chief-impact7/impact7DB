import admin from 'firebase-admin';
import { deriveTenure } from '@impact7/shared/history';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname, '..', 'service-account.json'), 'utf8'))),
});
const db = admin.firestore();

const id = '심예율_1049477532';
const logsSnap = await db.collection('history_logs').where('doc_id', '==', id).orderBy('timestamp', 'desc').limit(200).get();
const logs = [];
logsSnap.forEach(d => logs.push({ id: d.id, ...d.data() }));
const attSnap = await db.collection('daily_records').where('student_id', '==', id).get();
const att = [];
attSnap.forEach(d => { const r = d.data(); att.push({ date: r.date, status: r.attendance?.status }); });

const getDate = (l) => l.timestamp?.toDate ? l.timestamp.toDate() : (l.timestamp ? new Date(l.timestamp) : null);
const ymd = (d) => d ? d.toISOString().slice(0, 10) : 'null';

console.log('=== history_logs (시간순) ===');
[...logs].sort((a, b) => getDate(a) - getDate(b)).forEach(l =>
  console.log(`  ${ymd(getDate(l))} [${l.change_type}] ${l.before} → ${l.after}`));
console.log('=== daily_records 출석 ===');
console.log('  ', att.length ? att.map(a => `${a.date}:${a.status}`).join(', ') : '(없음)');

const r = deriveTenure(logs, getDate, att);
console.log('=== deriveTenure 결과 ===');
console.log(`  startEvent=${ymd(r.startEvent)}  start(첫출석)=${ymd(r.start)}  end=${ymd(r.end)}`);
process.exit(0);
