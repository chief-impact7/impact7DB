# 공유 백엔드 AI 인증 통일 + 카카오/출결/결제 기반 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** exam·DSC의 AI 호출을 서버+Vertex AI+ADC로 통일하고(하이브리드 경로), 카카오·출결·결제 공유 서비스가 나중에 로직만 붙이면 되도록 기반을 깐다.

**Architecture:** impact7DB의 `functions-shared`(codebase `shared`)에 LLM 게이트웨이 Callable과 카카오/결제/출결 함수 골격을 둔다. exam(Next.js/App Hosting)은 자체 서버에서 `@google/genai` vertex 모드로 직접 호출. DSC(서버 없음)는 게이트웨이 Callable을 경유. 인증은 셋 다 ADC.

**Tech Stack:** Firebase Functions v2 (Node 22, ESM), `@google/genai`, Vertex AI, Firebase Auth + App Check, Firestore, Vitest. exam=Next.js/TypeScript, DSC=Vanilla JS + Vite.

**관련 spec:** `docs/superpowers/specs/2026-05-22-shared-backend-ai-unification-design.md`

**작업 repo 경로:**
- impact7DB: `/Users/jongsooyi/IMPACT7/impact7DB` (현재 worktree에서 작업)
- impact7exam: `/Users/jongsooyi/IMPACT7/impact7exam`
- impact7newDSC: `/Users/jongsooyi/IMPACT7/impact7newDSC`

> **크로스레포 주의:** 이 계획은 3개 repo를 수정한다. 각 repo는 독립 git 저장소이므로 커밋도 각 repo에서 따로 한다. impact7DB는 현재 worktree(`shared-backend-foundation`)에서 작업.

---

## Phase 0 — 사전 확인 & GCP 준비

### Task 0.1: Vertex AI API 활성화 확인

**Files:** 없음 (gcloud 확인)

- [ ] **Step 1: Vertex AI API 활성화 상태 확인**

Run:
```bash
gcloud services list --enabled --project impact7db --filter="config.name:aiplatform.googleapis.com" --format="value(config.name)"
```
Expected: `aiplatform.googleapis.com` 출력. 비어 있으면 다음 step.

- [ ] **Step 2: (필요 시) 활성화**

Run:
```bash
gcloud services enable aiplatform.googleapis.com --project impact7db
```
Expected: `Operation ... finished successfully.`

### Task 0.2: Vertex 모델명 확정

**Files:** 없음 (확인만)

현재 코드의 모델명: exam `gemini-3-flash-preview`(텍스트)·`gemini-2.5-pro`(비전/커멘터리)·`gemini-2.5-flash`(폴백), DSC `gemini-3.5-flash`. Vertex `global` 엔드포인트에서 사용 가능한 정확한 ID를 확정한다.

- [ ] **Step 1: Vertex 가용 Gemini 모델 목록 확인**

Run:
```bash
gcloud ai models list --region=global --project impact7db 2>/dev/null | grep -i gemini || echo "global 미지원 시 us-central1 재시도"
```
대안(웹): Vertex AI 모델 문서에서 `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3-*` 가용성 확인.

- [ ] **Step 2: 모델 매핑표를 이 계획에 기록**

확정된 ID를 아래 표에 채운다(구현 중 참조):

| 용도 | 현재 코드 모델 | Vertex 모델 ID(확정) |
|------|---------------|---------------------|
| exam 텍스트 | gemini-3-flash-preview | (확인) |
| exam 비전/커멘터리 | gemini-2.5-pro | (확인) |
| 공통 폴백 | gemini-2.5-flash | (확인) |
| DSC | gemini-3.5-flash | (확인) |

> 모델 ID가 Developer API와 동일하면(`gemini-2.5-flash` 등) 그대로 사용. preview/3.x가 Vertex에 없으면 가장 가까운 GA 모델로 매핑하고 spec 미해결 사항 갱신.

---

## Phase 1 — 공유 LLM 게이트웨이 (impact7DB / functions-shared)

### Task 1.1: functions-shared에 @google/genai 의존성 추가

**Files:**
- Modify: `functions-shared/package.json`

- [ ] **Step 1: 의존성 추가**

`functions-shared/package.json`의 `dependencies`를 다음으로 교체:
```json
  "dependencies": {
    "firebase-admin": "^13.0.0",
    "firebase-functions": "^7.0.0",
    "@google/genai": "^1.0.0"
  },
```

- [ ] **Step 2: 설치 확인**

Run: `cd functions-shared && npm install`
Expected: `@google/genai` 설치, 에러 없음. (lockfile 생성)

- [ ] **Step 3: vitest 추가 (테스트용)**

`functions-shared/package.json`에 추가:
```json
  "scripts": {
    "deploy": "firebase deploy --only functions:shared --project impact7db",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  },
```
Run: `npm install`

- [ ] **Step 4: Commit (impact7DB worktree)**

```bash
git add functions-shared/package.json functions-shared/package-lock.json
git commit -m "chore(shared): add @google/genai + vitest to shared functions"
```

### Task 1.2: Vertex 클라이언트 헬퍼

**Files:**
- Create: `functions-shared/src/vertex.js`
- Test: `functions-shared/test/vertex.test.js`

- [ ] **Step 1: 헬퍼 작성**

`functions-shared/src/vertex.js`:
```js
import { GoogleGenAI } from '@google/genai';

const PROJECT = 'impact7db';
const LOCATION = 'global';

let _client;
function client() {
  if (!_client) {
    _client = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });
  }
  return _client;
}

// 단순 텍스트 생성. config는 @google/genai generateContent config 그대로 통과.
export async function generateText(model, prompt, config = {}) {
  const resp = await client().models.generateContent({
    model,
    contents: prompt,
    config,
  });
  return resp.text ?? '';
}
```

- [ ] **Step 2: 테스트 작성 (모듈 구조만 검증)**

`functions-shared/test/vertex.test.js`:
```js
import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: vi.fn().mockResolvedValue({ text: 'hello' }) },
  })),
}));

describe('generateText', () => {
  it('returns model text', async () => {
    const { generateText } = await import('../src/vertex.js');
    const out = await generateText('gemini-2.5-flash', 'hi', {});
    expect(out).toBe('hello');
  });
});
```

- [ ] **Step 3: 테스트 실행 (실패→통과 확인)**

Run: `cd functions-shared && npx vitest run test/vertex.test.js`
Expected: PASS (mock 기준).

- [ ] **Step 4: Commit**

```bash
git add functions-shared/src/vertex.js functions-shared/test/vertex.test.js
git commit -m "feat(shared): add Vertex AI client helper"
```

### Task 1.3: 호출 로깅 헬퍼 (비용 가드)

**Files:**
- Create: `functions-shared/src/notifyLog.js`
- Test: `functions-shared/test/notifyLog.test.js`

> `notification_logs`는 트랙 B에서도 쓰는 공용 발송/호출 로그. LLM 호출도 여기 기록해 비용/사용량을 한 곳에서 관측한다.

- [ ] **Step 1: 헬퍼 작성**

`functions-shared/src/notifyLog.js`:
```js
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// 공용 로그: channel='llm'|'kakao'|'payment'|'attendance'
export async function writeLog(entry) {
  const db = getFirestore();
  await db.collection('notification_logs').add({
    ...entry,
    created_at: FieldValue.serverTimestamp(),
  });
}
```

- [ ] **Step 2: 테스트 작성**

`functions-shared/test/notifyLog.test.js`:
```js
import { describe, it, expect, vi } from 'vitest';

const addMock = vi.fn().mockResolvedValue({ id: 'x' });
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: () => ({ add: addMock }) }),
  FieldValue: { serverTimestamp: () => 'TS' },
}));

describe('writeLog', () => {
  it('writes entry with timestamp', async () => {
    const { writeLog } = await import('../src/notifyLog.js');
    await writeLog({ channel: 'llm', uid: 'u1' });
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'llm', uid: 'u1', created_at: 'TS' }),
    );
  });
});
```

- [ ] **Step 3: 테스트 실행**

Run: `cd functions-shared && npx vitest run test/notifyLog.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add functions-shared/src/notifyLog.js functions-shared/test/notifyLog.test.js
git commit -m "feat(shared): add notification_logs writer (cost/usage observability)"
```

### Task 1.4: llmGenerate Callable 게이트웨이

**Files:**
- Modify: `functions-shared/index.js`

- [ ] **Step 1: index.js에 게이트웨이 추가**

`functions-shared/index.js`를 다음으로 교체:
```js
import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { generateText } from './src/vertex.js';
import { writeLog } from './src/notifyLog.js';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  // Phase 0에서 확정한 추가 모델 ID를 여기에 등록
]);

// 공유 LLM 게이트웨이. DSC·향후 앱이 호출. exam은 자체 서버에서 직접 Vertex(게이트웨이 미경유).
export const llmGenerate = onCall(
  { enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const { prompt, model, config } = request.data ?? {};
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new HttpsError('invalid-argument', 'prompt(문자열)가 필요합니다.');
    }
    const useModel = model && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;

    try {
      const text = await generateText(useModel, prompt, config ?? {});
      await writeLog({ channel: 'llm', uid: request.auth.uid, model: useModel, ok: true });
      return { text, model: useModel };
    } catch (err) {
      await writeLog({ channel: 'llm', uid: request.auth.uid, model: useModel, ok: false, error: String(err?.message || err) });
      throw new HttpsError('internal', 'AI 생성 실패');
    }
  }
);

// codebase 슬롯 헬스체크 (기존 유지)
export const healthCheck = onRequest(
  { invoker: 'public' },
  (req, res) => {
    res.json({ status: 'ok', codebase: 'shared', ts: Date.now() });
  }
);
```

- [ ] **Step 2: 구문 확인**

Run: `cd functions-shared && node --check index.js`
Expected: 출력 없음(성공).

- [ ] **Step 3: Commit**

```bash
git add functions-shared/index.js
git commit -m "feat(shared): add llmGenerate Callable gateway (Auth+AppCheck+logging)"
```

---

## Phase 2 — exam 4개 모듈 Vertex 전환 (impact7exam)

> repo 이동: `/Users/jongsooyi/IMPACT7/impact7exam`. 각 모듈은 `@google/genai` vertex 모드로 전환. retry/fallback 정책 유지. 모델명은 Phase 0 확정값 사용.

### Task 2.1: exam Vertex 클라이언트 공용 모듈

**Files:**
- Create: `impact7exam/src/server/ai/vertexClient.ts`

- [ ] **Step 1: 공용 클라이언트 작성**

`impact7exam/src/server/ai/vertexClient.ts`:
```ts
import { GoogleGenAI } from "@google/genai";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "impact7db";
const LOCATION = process.env.VERTEX_LOCATION ?? "global";

let client: GoogleGenAI | null = null;

export function vertex(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });
  }
  return client;
}
```

- [ ] **Step 2: @google/genai 설치 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7exam && grep '"@google/genai"' package.json`
Expected: 이미 존재(generate.ts가 사용 중). 없으면 `npm install @google/genai`.

- [ ] **Step 3: Commit (impact7exam repo)**

```bash
cd /Users/jongsooyi/IMPACT7/impact7exam
git add src/server/ai/vertexClient.ts
git commit -m "feat(ai): add shared Vertex AI client (ADC, no API key)"
```

### Task 2.2: gemini.ts (텍스트) 전환

**Files:**
- Modify: `impact7exam/src/server/ai/gemini.ts`

- [ ] **Step 1: gemini.ts 전환**

`impact7exam/src/server/ai/gemini.ts`를 다음으로 교체:
```ts
import { callWithRetry, isRetriableError } from "@/server/ai/retry";
import { vertex } from "@/server/ai/vertexClient";

const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash"; // Phase 0 확정 모델
const FALLBACK_MODEL = "gemini-2.5-flash";

async function callGeminiWithModel(
  model: string,
  prompt: string,
  options?: { temperature?: number; maxOutputTokens?: number },
): Promise<string> {
  const resp = await vertex().models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxOutputTokens ?? 1024,
    },
  });
  return resp.text ?? "";
}

export async function callGemini(
  prompt: string,
  options?: { temperature?: number; maxOutputTokens?: number },
): Promise<string> {
  try {
    return await callWithRetry(
      () => callGeminiWithModel(GEMINI_TEXT_MODEL, prompt, options),
      "gemini-text",
    );
  } catch (err) {
    if (GEMINI_TEXT_MODEL !== FALLBACK_MODEL && isRetriableError(err)) {
      console.warn(`[gemini-text] ${GEMINI_TEXT_MODEL} 재시도 모두 실패, ${FALLBACK_MODEL}로 폴백`);
      return callGeminiWithModel(FALLBACK_MODEL, prompt, options);
    }
    throw err;
  }
}
```

> `isRetriableError`는 에러 메시지의 HTTP 상태 문자열을 본다. SDK 에러도 메시지에 상태 코드를 포함하므로 그대로 동작. 동작 안 하면 Task 2.6에서 보정.

- [ ] **Step 2: 타입체크**

Run: `cd /Users/jongsooyi/IMPACT7/impact7exam && npx tsc --noEmit`
Expected: 이 파일 관련 에러 없음.

- [ ] **Step 3: Commit**

```bash
git add src/server/ai/gemini.ts
git commit -m "feat(ai): switch text generation to Vertex (ADC)"
```

### Task 2.3: vision.ts (비전 단일/멀티) 전환

**Files:**
- Modify: `impact7exam/src/server/ai/vision.ts`

- [ ] **Step 1: vision.ts 전환**

`impact7exam/src/server/ai/vision.ts`를 다음으로 교체:
```ts
import { callWithRetry, isRetriableError } from "@/server/ai/retry";
import { vertex } from "@/server/ai/vertexClient";

const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL ?? "gemini-2.5-pro"; // Phase 0 확정
const FALLBACK_MODEL = "gemini-2.5-flash";

function imagePart(base64: string, mimeType: string) {
  return { inlineData: { mimeType, data: base64 } };
}

async function callVisionWithModel(
  model: string,
  prompt: string,
  images: Array<{ base64: string; mimeType: string }>,
  maxOutputTokens: number,
): Promise<string> {
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const img of images) parts.push(imagePart(img.base64, img.mimeType));

  const resp = await vertex().models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: { temperature: 0.2, maxOutputTokens },
  });
  const finishReason = resp.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.warn(`[vision] finishReason=${finishReason} — 응답이 잘렸을 수 있음`);
  }
  return resp.text ?? "";
}

export async function callGeminiVision(
  prompt: string,
  imageBase64: string,
  mimeType: string = "image/png",
): Promise<string> {
  const images = [{ base64: imageBase64, mimeType }];
  try {
    return await callWithRetry(
      () => callVisionWithModel(GEMINI_VISION_MODEL, prompt, images, 8192),
      "vision",
    );
  } catch (err) {
    if (GEMINI_VISION_MODEL !== FALLBACK_MODEL && isRetriableError(err)) {
      console.warn(`[vision] ${GEMINI_VISION_MODEL} 재시도 모두 실패, ${FALLBACK_MODEL}로 폴백`);
      return callVisionWithModel(FALLBACK_MODEL, prompt, images, 8192);
    }
    throw err;
  }
}

export async function callGeminiVisionMulti(
  prompt: string,
  images: Array<{ base64: string; mimeType: string }>,
): Promise<string> {
  if (images.length === 0) {
    throw new Error("callGeminiVisionMulti requires at least one image");
  }
  try {
    return await callWithRetry(
      () => callVisionWithModel(GEMINI_VISION_MODEL, prompt, images, 65536),
      "vision-multi",
    );
  } catch (err) {
    if (GEMINI_VISION_MODEL !== FALLBACK_MODEL && isRetriableError(err)) {
      console.warn(`[vision-multi] ${GEMINI_VISION_MODEL} 재시도 모두 실패, ${FALLBACK_MODEL}로 폴백`);
      return callVisionWithModel(FALLBACK_MODEL, prompt, images, 65536);
    }
    throw err;
  }
}
```

- [ ] **Step 2: 타입체크**

Run: `cd /Users/jongsooyi/IMPACT7/impact7exam && npx tsc --noEmit`
Expected: 이 파일 관련 에러 없음.

- [ ] **Step 3: Commit**

```bash
git add src/server/ai/vision.ts
git commit -m "feat(ai): switch vision (single/multi) to Vertex (ADC)"
```

### Task 2.4: commentary.ts (JSON 스키마+thinking) 전환

**Files:**
- Modify: `impact7exam/src/server/growth-report/commentary.ts`

- [ ] **Step 1: callGeminiJson 함수만 교체**

`impact7exam/src/server/growth-report/commentary.ts`의 `callGeminiJson` 함수(98-132행 부근)를 다음으로 교체하고, `generateCommentary` 안의 `const apiKey = ...` 가드(135-140행)를 제거:
```ts
import { vertex } from "@/server/ai/vertexClient";

async function callGeminiJson(model: string, prompt: string): Promise<string> {
  const resp = await vertex().models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.7,
      maxOutputTokens: 16384,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });
  const finishReason = resp.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    throw new Error(`Gemini finishReason=${finishReason}`);
  }
  return resp.text ?? "";
}
```

`generateCommentary` 시작부의 API 키 가드를 제거(키 없이 항상 시도, 실패 시 기존 폴백 템플릿 경로 유지):
```ts
export async function generateCommentary(data: GrowthReportData): Promise<GenerateCommentaryResult> {
  const prompt = buildPrompt(data);
  const modelsToTry: string[] = [PRIMARY_MODEL];
  if (PRIMARY_MODEL !== FALLBACK_MODEL) modelsToTry.push(FALLBACK_MODEL);
  // ... 이하 기존 for 루프 그대로 ...
```

> `RESPONSE_SCHEMA`는 SDK의 `responseSchema`에 그대로 전달. 타입 충돌 시 `responseSchema: RESPONSE_SCHEMA as unknown as Schema`로 캐스팅(import `Schema` from `@google/genai`).

- [ ] **Step 2: 타입체크**

Run: `cd /Users/jongsooyi/IMPACT7/impact7exam && npx tsc --noEmit`
Expected: commentary.ts 관련 에러 없음.

- [ ] **Step 3: Commit**

```bash
git add src/server/growth-report/commentary.ts
git commit -m "feat(ai): switch growth-report commentary to Vertex (ADC)"
```

### Task 2.5: generate.ts 전환 (가장 단순)

**Files:**
- Modify: `impact7exam/src/server/analyses/generate.ts:111-117`

- [ ] **Step 1: 클라이언트 초기화만 교체**

`generate.ts`의 `generateAiResult` 시작부:
```ts
export async function generateAiResult(a: ExamAnalysis): Promise<AiAnalysisResult & { hash: string }> {
  const ai = vertex();
  const prompt = buildPrompt(a);
```
파일 상단 import 교체: `import { GoogleGenAI } from "@google/genai";` 제거, `import { vertex } from "@/server/ai/vertexClient";` 추가. `const apiKey = process.env.GEMINI_API_KEY; if (!apiKey) throw ...; const ai = new GoogleGenAI({ apiKey });` 3줄 제거.

- [ ] **Step 2: 타입체크**

Run: `cd /Users/jongsooyi/IMPACT7/impact7exam && npx tsc --noEmit`
Expected: 전체 에러 없음.

- [ ] **Step 3: Commit**

```bash
git add src/server/analyses/generate.ts
git commit -m "feat(ai): switch analyses generate to Vertex (ADC)"
```

### Task 2.6: exam 회귀 테스트 + env 정리

**Files:**
- Modify: `impact7exam/apphosting.yaml` (GEMINI_API_KEY env 제거)

- [ ] **Step 1: 기존 테스트 실행**

Run: `cd /Users/jongsooyi/IMPACT7/impact7exam && npm test 2>&1 | tail -30`
Expected: AI 모듈 관련 테스트가 있으면 mock 기준 PASS. fetch mock이 있던 테스트는 SDK mock으로 갱신 필요 — 실패 시 해당 테스트의 mock을 `vertex()` 모킹으로 교체.

- [ ] **Step 2: apphosting.yaml에서 GEMINI_API_KEY 제거**

`impact7exam/apphosting.yaml`에서 `GEMINI_API_KEY` 관련 env/secret 항목 삭제(있으면). Vertex는 ADC를 쓰므로 키 불필요.

- [ ] **Step 3: Commit**

```bash
git add apphosting.yaml
git commit -m "chore(ai): drop GEMINI_API_KEY env (Vertex uses ADC)"
```

---

## Phase 3 — DSC 게이트웨이 전환 (impact7newDSC)

> repo 이동: `/Users/jongsooyi/IMPACT7/impact7newDSC`. 클라 Vertex(`firebase/ai`)를 게이트웨이 Callable로 교체.

### Task 3.1: firebase-config.js에 functions 초기화 추가

**Files:**
- Modify: `impact7newDSC/firebase-config.js`

- [ ] **Step 1: 현재 firebase-config 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7newDSC && cat firebase-config.js`
Expected: app/auth/firestore 초기화 내용 파악.

- [ ] **Step 2: functions export 추가**

`firebase-config.js`에 추가(asia-northeast3 리전 명시):
```js
import { getFunctions } from 'firebase/functions';
// ... 기존 app 초기화 이후 ...
export const functions = getFunctions(app, 'asia-northeast3');
```

- [ ] **Step 3: Commit (impact7newDSC repo)**

```bash
cd /Users/jongsooyi/IMPACT7/impact7newDSC
git add firebase-config.js
git commit -m "feat: init firebase functions client (asia-northeast3)"
```

### Task 3.2: firebase-ai.js를 게이트웨이 래퍼로 교체

**Files:**
- Modify: `impact7newDSC/firebase-ai.js`

- [ ] **Step 1: 래퍼로 교체**

`impact7newDSC/firebase-ai.js`를 다음으로 교체:
```js
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase-config.js';

const _llmGenerate = httpsCallable(functions, 'llmGenerate');

// 기존 geminiModel.generateContent(prompt) 호출부와 호환되는 얇은 어댑터.
// 반환 형태: { response: { text: () => string } } — 기존 사용처가 result.response.text() 패턴이면 유지.
export const geminiModel = {
  async generateContent(prompt) {
    const res = await _llmGenerate({ prompt });
    const text = res.data?.text ?? '';
    return { response: { text: () => text }, text };
  },
};
```

> **확인 필요:** 기존 `gemini-queue.js`/`parent-message.js`가 `result.response.text()`를 쓰는지 `result.text`를 쓰는지 Step 2에서 확인하고 어댑터 반환형을 맞춘다.

- [ ] **Step 2: 기존 사용처의 응답 추출 패턴 확인**

Run:
```bash
cd /Users/jongsooyi/IMPACT7/impact7newDSC && grep -n "generateContent" -A3 gemini-queue.js parent-message.js
```
Expected: `result.response.text()` 또는 유사 패턴 확인. 어댑터 반환형이 안 맞으면 Step 1의 반환 객체를 사용처에 맞게 수정.

- [ ] **Step 3: 구문 확인**

Run: `node --check firebase-ai.js`
Expected: 출력 없음.

- [ ] **Step 4: Commit**

```bash
git add firebase-ai.js
git commit -m "feat: route DSC AI calls through shared llmGenerate gateway"
```

### Task 3.3: DSC App Check 상태 확인

**Files:** 없음 (확인)

> 게이트웨이가 `enforceAppCheck: true`이므로 DSC가 App Check를 등록·초기화하지 않으면 호출이 거부된다.

- [ ] **Step 1: DSC App Check 초기화 여부 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7newDSC && grep -rn "AppCheck\|app-check\|ReCaptcha" --include="*.js" . | grep -v node_modules`
Expected: App Check 초기화가 있으면 OK. 없으면 Step 2.

- [ ] **Step 2: (App Check 미설정 시) 게이트웨이 enforce 완화 결정**

선택지 — 사용자 확인 필요:
- (a) DSC에 App Check(reCAPTCHA v3) 추가
- (b) 게이트웨이 `enforceAppCheck: false`로 시작하고 Auth만으로 보호 (App Check는 후속 작업)

> 기본값: (b)로 시작해 배포를 막지 않되, spec 미해결 사항에 "DSC App Check 후속 추가" 기록.

---

## Phase 4 — 카카오/출결/결제 기반 (impact7DB / functions-shared, 중간 깊이)

> 함수 본문은 미구현(no-op). 시그니처·라우팅·공통 유틸 골격·스키마·rules·secret 슬롯만.

### Task 4.1: 공통 유틸 골격 (멱등키 / 서명검증)

**Files:**
- Create: `functions-shared/src/idempotency.js`
- Create: `functions-shared/src/verifySignature.js`

- [ ] **Step 1: 멱등키 헬퍼**

`functions-shared/src/idempotency.js`:
```js
import { getFirestore } from 'firebase-admin/firestore';

// 멱등키를 payment_records에 기록. 이미 처리됐으면 false 반환(중복).
// 실제 결제 검증 로직은 나중에 paymentHook에서 호출.
export async function claimIdempotencyKey(key) {
  const db = getFirestore();
  const ref = db.collection('payment_records').doc(key);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { claimed_at: new Date(), status: 'pending' });
    return true;
  });
}
```

- [ ] **Step 2: 서명검증 인터페이스 (골격)**

`functions-shared/src/verifySignature.js`:
```js
// PG 웹훅 서명검증. 실제 알고리즘은 PG사 확정 후 구현.
// 지금은 인터페이스만 — 호출되면 미구현 표시.
export function verifyPaymentSignature(_rawBody, _signatureHeader, _secret) {
  throw new Error('verifyPaymentSignature: not implemented (PG사 확정 후)');
}
```

- [ ] **Step 3: 구문 확인 + Commit**

Run: `cd functions-shared && node --check src/idempotency.js && node --check src/verifySignature.js`
```bash
git add functions-shared/src/idempotency.js functions-shared/src/verifySignature.js
git commit -m "feat(shared): scaffold idempotency + signature-verify utils (no-op)"
```

### Task 4.2: 함수 골격 (sendKakao / paymentHook / onAttendance)

**Files:**
- Modify: `functions-shared/index.js`

- [ ] **Step 1: index.js에 골격 함수 추가**

`functions-shared/index.js`에 import와 함수 추가:
```js
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

// === 카카오/결제/출결 (골격 — 본문은 2026 하반기) ===

// 카카오 알림톡/친구톡 발송 (Callable). 실 API 연동은 나중.
export const sendKakao = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  throw new HttpsError('unimplemented', 'sendKakao: not implemented (카카오 API 확정 후)');
});

// PG 결제 웹훅 (HTTP). 서명검증·멱등은 src 유틸로 위임 예정.
export const paymentHook = onRequest({ invoker: 'public' }, (req, res) => {
  console.warn('[paymentHook] not implemented — received webhook, ignoring');
  res.status(503).json({ error: 'not implemented' });
});

// 출결 변경 → 카톡 알림 트리거. 컬렉션 경로는 DSC 출결 스키마 확정 후.
export const onAttendance = onDocumentWritten(
  { document: 'attendance/{docId}' },
  async (event) => {
    console.log('[onAttendance] not implemented — change observed', event.params.docId);
    return null;
  }
);
```

- [ ] **Step 2: 구문 확인**

Run: `cd functions-shared && node --check index.js`
Expected: 출력 없음.

- [ ] **Step 3: Commit**

```bash
git add functions-shared/index.js
git commit -m "feat(shared): scaffold sendKakao/paymentHook/onAttendance (no-op)"
```

### Task 4.3: Firestore 스키마 rules 슬롯

**Files:**
- Modify: `firestore.rules` (impact7DB worktree)

- [ ] **Step 1: 현재 rules 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7DB/.claude/worktrees/shared-backend-foundation && grep -n "match /" firestore.rules | head -40`
Expected: 기존 컬렉션 매치 패턴 파악.

- [ ] **Step 2: 두 컬렉션 슬롯 추가**

`firestore.rules`의 적절한 위치(다른 match 블록과 동일 들여쓰기)에 추가:
```
    // 공유 백엔드 로그 — 서버(Functions)만 쓰기, 클라 읽기 금지
    match /notification_logs/{logId} {
      allow read, write: if false; // Functions admin SDK만 (rules 우회)
    }

    // 결제 기록 — 서버(Functions)만, 멱등키=docId
    match /payment_records/{key} {
      allow read, write: if false; // Functions admin SDK만
    }
```

> Admin SDK는 rules를 우회하므로 `if false`로 클라 접근을 완전 차단해도 Functions 쓰기는 동작. 추후 관리자 읽기가 필요하면 그때 완화.

- [ ] **Step 3: rules 문법 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7DB/.claude/worktrees/shared-backend-foundation && firebase deploy --only firestore:rules --project impact7db --dry-run 2>&1 | tail -5`
Expected: 문법 에러 없음. (실제 배포는 Phase 5)

- [ ] **Step 4: Commit**

```bash
git add firestore.rules
git commit -m "feat(rules): add notification_logs + payment_records slots (server-only)"
```

> **rules 동기화 규율** (메모리 `feedback_rules_sync_commit`): firestore.rules 변경은 4개 repo 동기화 대상. 이 슬롯 추가도 배포 후 DSC/HR/exam에 복사하고 4-repo git clean 확인. Phase 5에서 처리.

### Task 4.4: Secret Manager 슬롯 (placeholder)

**Files:** 없음 (gcloud)

- [ ] **Step 1: 빈 시크릿 슬롯 생성**

Run:
```bash
printf 'PLACEHOLDER' | gcloud secrets create kakao-api-key --data-file=- --project impact7db 2>&1 || echo "이미 존재"
printf 'PLACEHOLDER' | gcloud secrets create pg-secret-key --data-file=- --project impact7db 2>&1 || echo "이미 존재"
```
Expected: 생성 또는 "이미 존재".

> 실제 키 값은 카카오/PG 계약 후 새 버전으로 등록. 함수에서 `defineSecret('kakao-api-key')`로 참조(실 로직 구현 시).

---

## Phase 5 — 배포 & 검증

### Task 5.1: IAM — Vertex 권한 부여

**Files:** 없음 (gcloud)

- [ ] **Step 1: functions-shared 런타임 SA 확인 및 권한 부여**

Run:
```bash
# 기본 compute SA (2세대 함수 기본 런타임 SA)
PROJ_NUM=$(gcloud projects describe impact7db --format='value(projectNumber)')
gcloud projects add-iam-policy-binding impact7db \
  --member="serviceAccount:${PROJ_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```
Expected: 정책 업데이트 성공.

- [ ] **Step 2: exam App Hosting SA에 권한 부여**

Run:
```bash
# App Hosting 백엔드의 런타임 SA 확인 (firebase apphosting:backends:list 또는 콘솔)
# 확인된 SA에 부여:
gcloud projects add-iam-policy-binding impact7db \
  --member="serviceAccount:<EXAM_APPHOSTING_SA>" \
  --role="roles/aiplatform.user"
```
Expected: 정책 업데이트 성공. SA를 모르면 `firebase apphosting:backends:list --project impact7db`로 확인.

### Task 5.2: 게이트웨이 + rules 배포 (impact7DB)

**Files:** 없음 (배포)

- [ ] **Step 1: shared codebase만 배포 (클로버링 안전)**

Run:
```bash
cd /Users/jongsooyi/IMPACT7/impact7DB/.claude/worktrees/shared-backend-foundation
firebase deploy --only functions:shared --project impact7db
```
Expected: `llmGenerate`, `sendKakao`, `paymentHook`, `onAttendance`, `healthCheck` 배포 성공. **leave-request 함수는 목록에 없어야 함**(codebase 분리 확인).

- [ ] **Step 2: rules 배포**

Run:
```bash
firebase deploy --only firestore:rules --project impact7db
```
Expected: 성공.

- [ ] **Step 3: 게이트웨이 헬스 확인**

Run: `curl -s "https://asia-northeast3-impact7db.cloudfunctions.net/healthCheck"`
Expected: `{"status":"ok","codebase":"shared",...}`

### Task 5.3: exam 배포 & 동작 확인

- [ ] **Step 1: exam App Hosting 배포**

exam은 git push 시 App Hosting 자동 배포(또는 `firebase apphosting` 흐름). 변경 push 후 빌드 성공 확인.

- [ ] **Step 2: AI 기능 1개 실제 호출 확인**

성적표 코멘트(commentary) 또는 분석(generate) 1건을 실제 실행해 Vertex 응답이 오는지 확인. 에러 시 IAM(aiplatform.user)·모델명 점검.

### Task 5.4: DSC 배포 & 동작 확인

- [ ] **Step 1: DSC 빌드 & 배포**

Run: `cd /Users/jongsooyi/IMPACT7/impact7newDSC && npx vite build && firebase deploy --only hosting --project impact7db`
Expected: 빌드·배포 성공.

- [ ] **Step 2: 학부모 메시지 생성(parent-message) 또는 gemini-queue 1건 실행**

게이트웨이 경유로 텍스트가 생성되는지 확인. 401/403이면 Auth/App Check, 500이면 게이트웨이 로그(`firebase functions:log --only llmGenerate`) 확인.

### Task 5.5: rules 4-repo 동기화

**Files:**
- Modify: DSC/HR/exam의 `firestore.rules`

- [ ] **Step 1: 변경된 firestore.rules를 다른 repo에 복사**

impact7DB의 `firestore.rules`(notification_logs/payment_records 슬롯 포함)를 DSC/HR/exam에 복사.

- [ ] **Step 2: 각 repo 커밋 & 4-repo git clean 확인**

Run (각 repo): `git add firestore.rules && git commit -m "chore(rules): sync notification_logs/payment_records slots"`
4개 repo 모두 `git status` clean 확인. (메모리 `feedback_rules_sync_commit`)

### Task 5.6: 메모리 갱신

**Files:**
- Modify: `/Users/jongsooyi/IMPACT7/impact7DB/.memory/project_shared_backend_foundation.md`
- Modify: `/Users/jongsooyi/IMPACT7/impact7DB/.memory/MEMORY.md` (필요 시)

- [ ] **Step 1: 범위 변경 반영**

`project_shared_backend_foundation.md`에 "2026-05-22: AI 인증 통일은 실구현+배포 완료(exam=직접 Vertex, DSC=게이트웨이), 카카오/결제/출결은 골격까지. LLM 게이트웨이=llmGenerate Callable" 갱신.

- [ ] **Step 2: Commit**

```bash
cd /Users/jongsooyi/IMPACT7/impact7DB/.claude/worktrees/shared-backend-foundation
git add .memory/
git commit -m "docs(memory): update shared-backend scope — AI unified+deployed, kakao/pay/attendance scaffolded"
```

---

## Self-Review 체크리스트 결과

- **Spec coverage:** 트랙 A(게이트웨이/exam/DSC) = Phase 1-3 / 트랙 B(골격/유틸/스키마/secret) = Phase 4 / 배포·IAM·Secret = Phase 0,5 / 메모리 갱신 = Task 5.6. 전 항목 매핑됨.
- **미해결(의도된 확인 step):** 모델명(Task 0.2), `@google/genai`의 responseSchema/thinkingConfig 동작(Task 2.4 타입체크+5.3 실호출), DSC App Check(Task 3.3), exam App Hosting SA(Task 5.2). 모두 계획 내 확인 step으로 처리.
- **Type consistency:** 게이트웨이 반환 `{ text, model }` ↔ DSC 어댑터 `res.data.text` 일치. `generateText(model, prompt, config)` 시그니처 Phase 1 정의 ↔ 사용 일치. `vertex()` 헬퍼 이름 exam 전역 일치.
