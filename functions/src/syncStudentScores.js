// F-11: 성적 N+1 제거용 학생 중심 요약(student_scores/{studentId}).
// results·external_score_events 쓰기를 trigger로 받아 학생별 raw 요약을 비정규화한다.
// 점수 해석(reportScoreValue/renderDomainScores)은 DSC가 유지 — 여기선 raw + meta만 모은다(계산 drift 회피).
//
// 구조: student_scores/{studentId} = {
//   academy: { [examId]: { examId, title, date, deptId, result } },   // results/{examId}/students/* (registrationNo 역조회)
//   external: { [eventId]: { eventId, type, event, score } },         // external_score_events/{eventId}/students/{studentId}
//   updated_at
// }
//
// trigger 로직은 db를 받는 순수 helper로 분리해 emulator 테스트가 가능하다.
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

// result 문서에는 studentId가 없고 docId도 auto-id다. registrationNo(=학생 studentNumber) 우선,
// 없으면 studentName으로 역조회한다. 동명이인이면 모호하므로 매핑하지 않는다(누락 로그).
export async function resolveStudentId(db, data) {
  if (data.registrationNo != null) {
    const q = await db.collection('students').where('studentNumber', '==', data.registrationNo).limit(2).get();
    if (q.size === 1) return q.docs[0].id;
  }
  if (data.studentName) {
    const q = await db.collection('students').where('name', '==', data.studentName).limit(2).get();
    if (q.size === 1) return q.docs[0].id;
  }
  return null;
}

export async function syncExternalScore(db, eventId, studentId, after) {
  const ref = db.doc(`student_scores/${studentId}`);
  if (!after) {
    await ref.update({ [`external.${eventId}`]: FieldValue.delete(), updated_at: FieldValue.serverTimestamp() }).catch(() => {});
    return { action: 'delete', studentId };
  }
  const eventMeta = (await db.doc(`external_score_events/${eventId}`).get()).data() || {};
  await ref.set({
    external: { [eventId]: { eventId, type: eventMeta.type || '', event: eventMeta, score: after } },
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { action: 'set', studentId, type: eventMeta.type };
}

export async function syncResultScore(db, examId, after, before) {
  const data = after || before;
  if (!data) return { skipped: 'no-data' };
  const studentId = await resolveStudentId(db, data);
  if (!studentId) return { skipped: 'unresolved', reg: data.registrationNo, name: data.studentName };
  const ref = db.doc(`student_scores/${studentId}`);
  if (!after) {
    await ref.update({ [`academy.${examId}`]: FieldValue.delete(), updated_at: FieldValue.serverTimestamp() }).catch(() => {});
    return { action: 'delete', studentId, examId };
  }
  const examMeta = (await db.doc(`exams/${examId}`).get()).data() || {};
  await ref.set({
    academy: { [examId]: { examId, title: examMeta.title || '', date: examMeta.schedule?.startDate || '', deptId: examMeta.deptId || '', result: after } },
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { action: 'set', studentId, examId };
}

export const onExternalScoreWritten = onDocumentWritten(
  { document: 'external_score_events/{eventId}/students/{studentId}', retry: false },
  async (event) => {
    const db = getFirestore();
    await syncExternalScore(db, event.params.eventId, event.params.studentId, event.data?.after?.data());
    return null;
  }
);

export const onResultScoreWritten = onDocumentWritten(
  { document: 'results/{examId}/students/{resultDocId}', retry: false },
  async (event) => {
    const db = getFirestore();
    const r = await syncResultScore(db, event.params.examId, event.data?.after?.data(), event.data?.before?.data());
    if (r.skipped === 'unresolved') {
      console.warn(`[student-scores] result→student 매핑 실패 examId=${event.params.examId} reg=${r.reg} name=${r.name}`);
    }
    return null;
  }
);
