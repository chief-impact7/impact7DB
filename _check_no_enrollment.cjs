const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(require("./service-account.json")) });
const db = admin.firestore();

async function main() {
  const snap = await db.collection("students").get();
  let total = 0, jaewon = 0, noEnroll = 0;
  const list = [];

  snap.forEach(doc => {
    const d = doc.data();
    total++;
    if (d.status === "재원") {
      jaewon++;
      const has = (d.enrollments || []).some(e => e.semester === "2026-Spring");
      if (!has) {
        noEnroll++;
        list.push(`${d.name} | ${d.school || ""} | ${d.level || ""}${d.grade || ""}`);
      }
    }
  });

  console.log("전체 학생:", total);
  console.log("재원 학생:", jaewon);
  console.log("재원인데 2026-Spring 없음:", noEnroll);
  console.log("---");
  list.forEach(s => console.log(s));
  process.exit();
}
main();
