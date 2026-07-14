#!/usr/bin/env node
import { readFileSync } from "node:fs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function promptText(payload) {
  return [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
  ].map(safeString).find((value) => value.trim())?.trim() ?? "";
}

function workspaceText(payload) {
  const paths = Array.isArray(payload.workspacePaths)
    ? payload.workspacePaths
    : Array.isArray(payload.workspace_paths)
      ? payload.workspace_paths
      : [];
  return [payload.cwd, process.cwd(), ...paths].map(safeString).join("\n");
}

const raw = readStdin();
let payload;

try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const hookEventName = safeString(payload.hook_event_name || payload.hookEventName || payload.event || payload.name);
const isPromptHook = hookEventName === "UserPromptSubmit";
const isAntigravityPreInvocation = hookEventName === "PreInvocation" || hookEventName === "";
if (!isPromptHook && !isAntigravityPreInvocation) {
  process.exit(0);
}

if (!workspaceText(payload).includes("/Users/jongsooyi/IMPACT7/impact7")) {
  process.exit(0);
}

const prompt = promptText(payload);
if (isPromptHook && !prompt) {
  process.exit(0);
}

const normalized = prompt.toLowerCase();
const hasSearchIntent = /검색|찾아|어디|위치|함수|기능|코드|로직|구현|확인|분석|review|리뷰|bug|버그|drift|계약|contract|search|find|where|function|code|logic|implementation|analy[sz]e|생성|만들|작성|추가|수정|개선|렌더|화면|패널|버튼|입력|폼|ui|ux|render|build|create|add|implement|fix|refactor|design/.test(normalized);
const hasImpact7Domain = /impact7|shared|학생|재원|퇴원|등원|상태|status|status2|수업|이력|history|내신|자유학기|라벨|표시|검색어|번호|student|enrollment|class|반 이동|승격|promote|matching|match|매칭|school|grade|branch/.test(normalized);

if (isPromptHook && (!hasSearchIntent || !hasImpact7Domain)) {
  process.exit(0);
}

const additionalContext = [
  "impact7 shared-first search rule:",
  "Before searching or judging the current app, inspect `/Users/jongsooyi/IMPACT7/impact7-shared/package.json` exports and the relevant `@impact7/shared` module.",
  "Search order: shared package export map -> relevant shared module -> current app local implementation -> drift comparison.",
  "Canonical shared surfaces: `history-classifier.js`, `enrollment-status.js`, `enrollment-derivation.js`, `class-move.js`, `promote-enroll.js`, `student-number.js`, `student-label.js`, `staff-label.js`, `datetime.js`, `ime-input.js`, `html-escape.js`, `phone.js`, `branch.js`.",
  "For student status/enrollment/history/label/number/class move/promotion/matching work, report the shared contract first and treat local mismatch as potential drift.",
  "When GENERATING new code or UI/UX in any impact7 app, consult the shared modules first and reuse them instead of writing local equivalents; if a needed pure function is missing from shared, propose adding it to shared rather than implementing locally.",
].join(" ");

if (isAntigravityPreInvocation) {
  process.stdout.write(JSON.stringify({
    injectSteps: [
      {
        ephemeralMessage: additionalContext,
      },
    ],
  }) + "\n");
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName,
    additionalContext,
  },
}) + "\n");
