const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(require("./service-account.json")) });
const db = admin.firestore();

async function main() {
  const snap = await db.collection("students").get();
  const targets = [];

  snap.forEach(doc => {
    const d = doc.data();
    if (d.status === "재원") {
      const has = (d.enrollments || []).some(e => e.semester === "2026-Spring");
      if (!has) targets.push(doc.id);
    }
  });

  console.log(`퇴원 처리 대상: ${targets.length}명`);

  // Firestore batch는 최대 500개씩
  const batchSize = 500;
  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = db.batch();
    const chunk = targets.slice(i, i + batchSize);
    chunk.forEach(id => {
      batch.update(db.collection("students").doc(id), { status: "퇴원" });
    });
    await batch.commit();
    console.log(`${Math.min(i + batchSize, targets.length)} / ${targets.length} 완료`);
  }

  console.log("전체 완료");
  process.exit();
}
main().catch(e => { console.error(e); process.exit(1); });
