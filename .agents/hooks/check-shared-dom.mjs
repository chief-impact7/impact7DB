#!/usr/bin/env node
// 공유 DOM 유틸(a11y-dom.js) 동기화 검증.
// 마스터(.agents/shared-dom/a11y-dom.js)와 각 앱 루트 복사본이 동일한지 확인해
// 한쪽만 고쳐 drift가 생기는 것을 차단한다(DSC·DB 바닐라 JS 앱만 사용).
//   사용:  node check-shared-dom.mjs            # 전체
//          node check-shared-dom.mjs --app dsc  # 특정 앱 (pre-push)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const masterPath = join(here, '..', 'shared-dom', 'a11y-dom.js');
const master = readFileSync(masterPath, 'utf8');

const apps = {
  dsc: '/Users/jongsooyi/projects/impact7newDSC/a11y-dom.js',
  db: '/Users/jongsooyi/projects/impact7DB/a11y-dom.js',
};
const onlyApp = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] : null;

const drift = [];
let checked = 0;
for (const [app, path] of Object.entries(apps)) {
  if (onlyApp && app !== onlyApp) continue;
  let copy;
  try { copy = readFileSync(path, 'utf8'); }
  catch { drift.push(`${app} — a11y-dom.js 없음 (${path})`); continue; }
  checked++;
  if (copy !== master) drift.push(`${app} — a11y-dom.js가 마스터와 다름`);
}

if (drift.length) {
  console.error('❌ 공유 DOM 유틸 drift (마스터: .agents/shared-dom/a11y-dom.js):');
  for (const d of drift) console.error('   ' + d);
  console.error('\n→ 마스터를 고쳤으면 각 앱 루트로 복사, 앱에서 고쳤으면 마스터에 반영 후 재배포하라.');
  process.exit(1);
}
console.log(`✅ 공유 DOM 유틸 동기화 일치 — ${checked}개 앱${onlyApp ? ` (${onlyApp})` : ''}`);
