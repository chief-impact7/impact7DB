#!/usr/bin/env node
// impact7 디자인 토큰 SSoT 검증.
// 마스터(.agents/design-tokens.json)의 값과 각 앱 CSS의 실제 토큰 값을 대조해
// drift를 차단한다. 토큰 값은 마스터에서만 바꾸고, 이 스크립트로 4앱 동기화를 강제한다.
//   사용:  node check-design-tokens.mjs          # 전체 앱 검증
//          node check-design-tokens.mjs --app dsc # 특정 앱만 (pre-push 등)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const master = JSON.parse(readFileSync(join(here, '..', 'design-tokens.json'), 'utf8'));

const onlyApp = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] : null;
// 잘못된 --app(오타·값 누락)이 "0건 검사 후 통과"하는 silent bypass를 막는다 — 가드 무력화 방지.
if (onlyApp !== null && !master.files[onlyApp]) {
  console.error(`❌ 알 수 없는 앱: "${onlyApp}" (가능: ${Object.keys(master.files).join(' / ')})`);
  process.exit(1);
}

// 색/값 비교용 정규화: 공백 제거 + 소문자 (rgba(0, 0, 0, .64) === rgba(0,0,0,0.64))
const norm = (v) => v.replace(/\s+/g, '').toLowerCase();

// 첫 :root 블록만 본다 — 다크([data-theme="dark"]) 등 뒤쪽 블록의 값을 오매칭해
// drift를 놓치는 것을 구조적으로 막는다(소스 순서에 의존하지 않음). :root가 없으면(@theme 등) 전체.
const cssCache = {};
const readCss = (app) => {
  if (cssCache[app]) return cssCache[app];
  const full = readFileSync(master.files[app], 'utf8');
  const root = full.match(/:root\s*\{[\s\S]*?\}/);
  return (cssCache[app] = root ? root[0] : full);
};

const drift = [];
let checked = 0;
for (const [name, t] of Object.entries(master.tokens)) {
  for (const [app, varName] of Object.entries(t.vars)) {
    if (onlyApp && app !== onlyApp) continue;
    // `:` 경계가 있어 prefix 충돌(--warn vs --warn-bg) 없음. CSS 변수명엔 정규식 특수문자가 없다.
    const re = new RegExp(varName + '\\s*:\\s*([^;]+);');
    const m = readCss(app).match(re);
    if (!m) { drift.push(`${app.padEnd(4)} ${varName} (${name}) — 토큰을 못 찾음`); continue; }
    checked++;
    if (norm(m[1]) !== norm(t.value)) {
      drift.push(`${app.padEnd(4)} ${varName} (${name}) — "${m[1].trim()}" ≠ SSoT "${t.value}"`);
    }
  }
}

if (drift.length) {
  console.error('❌ 디자인 토큰 drift 발견 (SSoT: .agents/design-tokens.json):');
  for (const d of drift) console.error('   ' + d);
  console.error('\n→ 마스터 값으로 각 앱 CSS를 맞추거나, 의도된 변경이면 마스터를 먼저 수정하라.');
  process.exit(1);
}
// 검사 0건은 "통과"가 아니라 설정 오류 — silent pass 방지.
if (checked === 0) {
  console.error('❌ 검사한 토큰이 0건 — 마스터/대상 설정을 확인하라.');
  process.exit(1);
}
console.log(`✅ 디자인 토큰 SSoT 일치 — ${checked}개 (토큰 ${Object.keys(master.tokens).length} × 앱${onlyApp ? ` ${onlyApp}` : ' 4'})`);
