#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.svelte',
  '.py', '.go', '.rs', '.java', '.kt', '.swift', '.php', '.rb', '.vue'
]);

const SENSITIVE_FILES = new Set([
  'firebase.json',
  'firestore.rules',
  'storage.rules'
]);

function runGit(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }
  return result.stdout;
}

function repoRoot() {
  return runGit(['rev-parse', '--show-toplevel']).trim();
}

function gitDir() {
  return runGit(['rev-parse', '--git-dir']).trim();
}

function stagedFiles() {
  const output = runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return output.split('\0').filter(Boolean);
}

function extensionOf(path) {
  const name = path.toLowerCase();
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index) : '';
}

function isGuardedFile(file) {
  return SOURCE_EXTENSIONS.has(extensionOf(file)) || SENSITIVE_FILES.has(file);
}

function stagedGuardedFiles() {
  return stagedFiles().filter(isGuardedFile);
}

function stagedGuardedHash(files) {
  const diff = runGit(['diff', '--cached', '--binary', '--', ...files]);
  return createHash('sha256').update(diff).digest('hex');
}

function markerPath() {
  const dir = gitDir();
  const absoluteGitDir = dir.startsWith('/') ? dir : join(repoRoot(), dir);
  return join(absoluteGitDir, 'impact7-quality-reviewed.json');
}

function readMarker() {
  const path = markerPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(files, hash) {
  writeFileSync(markerPath(), `${JSON.stringify({
    hash,
    files,
    reviewedAt: new Date().toISOString()
  }, null, 2)}\n`);
}

function printNoGuardedFiles() {
  console.error('[impact7 quality] staged source/security changes: none');
}

function mark() {
  const files = stagedGuardedFiles();
  if (files.length === 0) {
    printNoGuardedFiles();
    return 0;
  }
  const hash = stagedGuardedHash(files);
  writeMarker(files, hash);
  console.error(`[impact7 quality] marked reviewed staged source/security diff (${files.length} files).`);
  return 0;
}

function check() {
  const files = stagedGuardedFiles();
  if (files.length === 0) return 0;

  const hash = stagedGuardedHash(files);
  const marker = readMarker();
  if (marker?.hash === hash) return 0;

  console.error('');
  console.error('[impact7 quality] commit blocked: staged source/security changes need simplify -> code review.');
  console.error('');
  console.error('Required before commit:');
  console.error('  1. Run /simplify on the staged source/security changes.');
  console.error('  2. Run /code-review, or an equivalent independent code review.');
  console.error('  3. Apply any required fixes.');
  console.error(`  4. From this repo root, mark the exact staged diff: node ${process.argv[1]} --mark`);
  console.error('');
  console.error('Staged source/security files:');
  for (const file of files) console.error(`  - ${file}`);
  console.error('');
  console.error('Bypass only for explicitly approved urgent commits:');
  console.error('  IMPACT7_SKIP_QUALITY_GUARD=1 git commit ...');
  console.error('');
  return 1;
}

if (process.env.IMPACT7_SKIP_QUALITY_GUARD === '1') {
  console.error('[impact7 quality] skipped by IMPACT7_SKIP_QUALITY_GUARD=1');
  process.exit(0);
}

const command = process.argv[2] || '--check';
try {
  if (command === '--mark') process.exit(mark());
  if (command === '--check') process.exit(check());
  console.error(`Unknown command: ${command}`);
  process.exit(2);
} catch (error) {
  console.error(`[impact7 quality] ${error.message}`);
  process.exit(2);
}
