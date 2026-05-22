import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export async function writeLog(entry) {
  const db = getFirestore();
  await db.collection('notification_logs').add({
    ...entry,
    created_at: FieldValue.serverTimestamp(),
  });
}
