import { mkdir, writeFile } from 'node:fs/promises';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  assertApplyFingerprint,
  backfillApprovalFingerprint,
  CLASS_SETTING_MANUAL_REASONS,
  MANUAL_REASONS,
  enrollmentFingerprint,
  planClassSettingBackfill,
  planStudentBackfill,
} from './lib/enrollment-account-backfill.mjs';

const APPLY = process.argv.includes('--apply');
const FINGERPRINT_INDEX = process.argv.indexOf('--fingerprint');
const PROVIDED_FINGERPRINT = FINGERPRINT_INDEX === -1 ? '' : process.argv[FINGERPRINT_INDEX + 1] || '';
const CHUNK_SIZE = 200;
const PROJECT_ID = 'impact7db';
const REPORT_PATH = new URL('../_workspace/account-backfill-report.json', import.meta.url);

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

function emptyReasonBuckets(labels) {
  return Object.fromEntries(Object.entries(labels).map(([code, reason]) => [code, { reason, items: [] }]));
}

function addManual(buckets, reasonCodes, item) {
  for (const code of reasonCodes) buckets[code].items.push(item);
}

function chunks(items) {
  return Array.from({ length: Math.ceil(items.length / CHUNK_SIZE) }, (_, index) =>
    items.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
  );
}

async function applyPlanChunks(plans, { label, unit, summaryKey, currentFingerprint, buildUpdate, onConflict }, report) {
  const planChunks = chunks(plans);
  for (const [index, chunk] of planChunks.entries()) {
    const currentDocs = await db.getAll(...chunk.map(plan => plan.ref));
    const batch = db.batch();
    let writes = 0;

    currentDocs.forEach((current, currentIndex) => {
      const plan = chunk[currentIndex];
      const fingerprint = currentFingerprint(current);
      if (!current.exists || fingerprint !== plan.fingerprint) {
        onConflict(plan, current.exists ? fingerprint : null);
        return;
      }
      batch.update(plan.ref, buildUpdate(plan), { lastUpdateTime: current.updateTime });
      writes++;
    });

    if (writes) await batch.commit();
    report.summary[summaryKey] += writes;
    console.log(`[${label}] 청크 ${index + 1}/${planChunks.length}: ${writes}/${chunk.length}${unit} 반영`);
  }
}

function applyStudentPlans(plans, report) {
  return applyPlanChunks(plans, {
    label: 'students',
    unit: '명',
    summaryKey: 'students_applied',
    currentFingerprint: current => enrollmentFingerprint(current.data()?.enrollments),
    buildUpdate: plan => ({
      enrollments: plan.enrollments,
      updated_at: FieldValue.serverTimestamp(),
      updated_by: 'enrollment-account-backfill',
    }),
    onConflict: (plan, currentFingerprint) => report.concurrent_changes.students.push({
      id: plan.id,
      initial_fingerprint: plan.fingerprint,
      current_fingerprint: currentFingerprint,
    }),
  }, report);
}

function applyClassSettingPlans(plans, report) {
  return applyPlanChunks(plans, {
    label: 'class_settings',
    unit: '건',
    summaryKey: 'class_settings_applied',
    currentFingerprint: current => JSON.stringify(current.data() || {}),
    buildUpdate: plan => plan.changes,
    onConflict: plan => report.concurrent_changes.class_settings.push({ id: plan.id }),
  }, report);
}

async function run() {
  console.log(APPLY ? '[APPLY] 200명 단위 반영' : '[DRY-RUN] Firestore 쓰기 0건');
  const [studentsSnapshot, classSettingsSnapshot] = await Promise.all([
    db.collection('students').get(),
    db.collection('class_settings').get(),
  ]);

  const report = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    summary: {
      students_scanned: studentsSnapshot.size,
      students_targeted: 0,
      students_auto_backfillable: 0,
      students_applied: 0,
      class_settings_scanned: classSettingsSnapshot.size,
      class_settings_targeted: 0,
      class_settings_auto_backfillable: 0,
      class_settings_applied: 0,
    },
    manual: {
      students_by_reason: emptyReasonBuckets(MANUAL_REASONS),
      class_settings_by_reason: emptyReasonBuckets(CLASS_SETTING_MANUAL_REASONS),
    },
    concurrent_changes: {
      students: [],
      class_settings: [],
    },
    class_settings_changes: [],
    samples: [],
  };

  const studentPlans = [];
  for (const doc of studentsSnapshot.docs) {
    const student = doc.data();
    const plan = planStudentBackfill(doc.id, student);
    if (!plan.targeted) continue;
    report.summary.students_targeted++;
    if (!plan.autoBackfillable) {
      addManual(report.manual.students_by_reason, plan.manualReasons, {
        id: doc.id,
        name: student.name || '',
        fingerprint: plan.fingerprint,
      });
      continue;
    }

    report.summary.students_auto_backfillable++;
    const recorded = {
      id: doc.id,
      name: student.name || '',
      ref: doc.ref,
      fingerprint: plan.fingerprint,
      enrollments: plan.enrollments,
      changes: plan.changes,
    };
    studentPlans.push(recorded);
    if (report.samples.length < 10) {
      report.samples.push({
        id: doc.id,
        name: student.name || '',
        fingerprint: plan.fingerprint,
        changes: plan.changes,
        account_groups: plan.accountGroups,
      });
    }
  }

  const classSettingPlans = [];
  for (const doc of classSettingsSnapshot.docs) {
    const settings = doc.data();
    const plan = planClassSettingBackfill(doc.id, settings);
    if (!plan.targeted) continue;
    report.summary.class_settings_targeted++;
    if (!plan.autoBackfillable) {
      addManual(report.manual.class_settings_by_reason, plan.manualReasons, { id: doc.id });
      continue;
    }
    report.summary.class_settings_auto_backfillable++;
    if (!Object.keys(plan.changes).length) continue;
    const recorded = {
      id: doc.id,
      ref: doc.ref,
      fingerprint: JSON.stringify(settings),
      changes: plan.changes,
    };
    classSettingPlans.push(recorded);
    report.class_settings_changes.push({ id: doc.id, changes: plan.changes });
  }

  const changeItemCount = studentPlans.reduce((sum, plan) => sum + plan.changes.length, 0)
    + classSettingPlans.reduce((sum, plan) => sum + Object.keys(plan.changes).length, 0);
  report.summary.change_items = changeItemCount;
  report.summary.fingerprint = backfillApprovalFingerprint(
    PROJECT_ID,
    report.summary.students_targeted,
    changeItemCount,
  );

  if (APPLY) {
    assertApplyFingerprint(PROVIDED_FINGERPRINT, report.summary.fingerprint);
    await applyStudentPlans(studentPlans, report);
    await applyClassSettingPlans(classSettingPlans, report);
  }

  await mkdir(new URL('../_workspace/', import.meta.url), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`보고서: ${REPORT_PATH.pathname}`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
