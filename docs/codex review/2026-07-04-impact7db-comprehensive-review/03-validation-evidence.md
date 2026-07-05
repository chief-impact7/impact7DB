# Validation Evidence

## 통과

### root build

명령:

```bash
npm run build
```

결과:
- 성공.
- Vite warning: `help-guide.js`가 `type="module"` 없이 로드되어 번들되지 않음.
- chunk warning: `dist/assets/index-*.js` 632.49KB.

### shared lock sync

명령:

```bash
npm run check:shared
```

결과:
- root/functions/functions-shared 모두 `@impact7/shared` spec `v1.38.0`과 lock `1.38.0` 일치.

### whitespace check

명령:

```bash
git diff --check
```

결과:
- 통과.

### root unit + Firestore rules

명령:

```bash
npm test
```

결과:
- unit 36 passed.
- Firestore rules 111 passed.
- emulator hub port 4400 충돌로 4401 사용 경고가 있었지만 테스트는 성공.

### Storage rules

명령:

```bash
npm run test:storage
```

결과:
- 16 passed.
- HR 경로 직접 read/write 거부, exam 경로 직원 허용/외부 거부, DSC student-records MIME 제한 검증.

### functions lint

명령:

```bash
cd functions && npm run lint
```

결과:
- 통과.

### functions-shared tests

명령:

```bash
cd functions-shared && npm test
```

결과:
- 50 files passed.
- 532 tests passed.

### functions emulator integration

명령:

```bash
cd functions
firebase emulators:exec --only firestore --project demo-impact7 "npx vitest run"
```

결과:
- 13 files passed.
- 97 tests passed.

## 실패 또는 주의

### root runtime audit

명령:

```bash
npm audit --omit=dev
```

결과:
- 실패.
- 3 vulnerabilities: moderate 1, high 1, critical 1.
- 핵심: `protobufjs <=7.6.2` critical.

### functions runtime audit

명령:

```bash
cd functions && npm audit --omit=dev
```

결과:
- 실패.
- 17 vulnerabilities: low 1, moderate 12, high 4.
- `npm audit fix --force`는 `firebase-admin@14.1.0` breaking change를 제안.

### functions-shared runtime audit

명령:

```bash
cd functions-shared && npm audit --omit=dev
```

결과:
- 실패.
- 11 vulnerabilities: moderate 9, high 2.
- `form-data`, `ws`, `uuid/firebase-admin` transitive 이슈 포함.

### functions 단독 npm test

명령:

```bash
cd functions && npm test
```

결과:
- 실패.
- `syncNaesinPeriod.integration.test.js`, `syncStudentScores.integration.test.js`, `finalize.integration.test.js` 총 23개가 hook timeout.
- 같은 테스트가 emulator wrapper에서는 통과하므로 제품 회귀보다 실행 계약 문제로 판단.

## 환경 참고

- 현재 워크트리 시작 상태: untracked `.omc/`, untracked `docs/codex review/`.
- `service-account.json`, `.env`, `dist`, `firestore-debug.log`는 git 추적 대상이 아니며 `.gitignore`에 포함.
