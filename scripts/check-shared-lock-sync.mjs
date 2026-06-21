// @impact7/shared의 package.json spec(git 태그)과 package-lock.json 고정 버전이 일치하는지,
// 그리고 root/functions/functions-shared 세 패키지가 같은 버전을 쓰는지(패키지 간 drift) 검증.
// 수동으로 package.json만 고치고 npm install을 돌리면 npm이 git spec 변경을 감지하지 못해
// lock이 옛 커밋을 유지한다(조용한 drift). 갱신은 반드시:
//   npm install "@impact7/shared@github:chief-impact7/impact7-shared#vX.Y.Z"
import { readFileSync } from 'fs';

const DIRS = ['.', 'functions', 'functions-shared'];
let failed = false;
const specVersions = {};

for (const dir of DIRS) {
  let pkg, lock;
  try {
    pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    lock = JSON.parse(readFileSync(`${dir}/package-lock.json`, 'utf8'));
  } catch (err) {
    console.error(`[shared-lock-sync] ${dir}: 파일 읽기 실패 — ${err.message}`);
    failed = true;
    continue;
  }
  const spec = pkg.dependencies?.['@impact7/shared'] || '';
  const specVersion = (spec.match(/#v(\d+\.\d+\.\d+)$/) || [])[1];
  const lockVersion = lock.packages?.['node_modules/@impact7/shared']?.version;
  if (!specVersion || !lockVersion) {
    console.error(`[shared-lock-sync] ${dir}: 파싱 실패 — spec "${spec}", lock "${lockVersion}"`);
    failed = true;
    continue;
  }
  specVersions[dir] = specVersion;
  if (specVersion !== lockVersion) {
    console.error(`[shared-lock-sync] ${dir}: 불일치! package.json v${specVersion} ↔ lock ${lockVersion} 커밋 고정.`);
    console.error(`  해결: (cd ${dir} && npm install "@impact7/shared@github:chief-impact7/impact7-shared#v${specVersion}")`);
    failed = true;
  } else {
    console.log(`✅ ${dir}: spec(v${specVersion}) ↔ lock(${lockVersion}) 일치`);
  }
}

// 패키지 간 버전 패리티(M-06/N-03) — 세 패키지가 동일 shared 계약을 써야 한다.
const uniq = [...new Set(Object.values(specVersions))];
if (uniq.length > 1) {
  console.error(`[shared-lock-sync] 패키지 간 버전 drift! ${JSON.stringify(specVersions)}`);
  console.error('  세 package.json의 @impact7/shared 버전을 일치시켜라.');
  failed = true;
}

if (failed) process.exit(1);
console.log(`✅ 전 패키지 @impact7/shared 동일 버전(v${uniq[0]}) + lock 일치`);
