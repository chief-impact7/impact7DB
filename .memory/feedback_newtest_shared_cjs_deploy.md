---
name: feedback-newtest-shared-cjs-deploy
description: newtest cloudrun(CJS)에서 @impact7/shared(ESM) 사용 패턴 + 운영 키 덮어쓰기 배포 함정
metadata:
  type: feedback
---

# newtest cloudrun — @impact7/shared(ESM) 사용 패턴 + 배포 함정

**Why:** newtest cloudrun은 CommonJS(`require`, package.json에 `"type"` 없음)인데 `@impact7/shared`는 순수 ESM(`"type":"module"`)이라 `require` 불가. 또 README의 전체 배포 명령을 그대로 쓰면 운영 키가 날아갈 수 있다. 두 함정 모두 한 번 겪으면 비자명하지만 운영 장애로 직결.

## CJS↔ESM — 동적 import 프리로드 패턴 (vendoring 대신)
`cloudrun/src/index.js`에서 SSoT 복사/재구현 없이 ESM을 쓰는 법:
```js
let studentFullLabel = () => "";
const labelReady = import("@impact7/shared/student-label").then((m) => {
  studentFullLabel = m.studentFullLabel;
});
// ...
labelReady.then(() => { app.listen(PORT, ...); })
  .catch((err) => { console.error("...로드 실패 — 서버 미기동:", err); process.exit(1); });
```
- 모듈을 시작 시 1회 동적 import → 변수 캐시. `app.listen`을 `labelReady` 뒤로 게이팅하면 모든 핸들러에서 **동기 호출** 유지(호출부 async 변환 불필요).
- 로드 실패 시 `process.exit(1)` → 조용한 빈-라벨 서빙 방지. 그래서 **"listening on" 로그가 뜨면 ESM 로드 성공 + 서버 정상의 증거**(검증 지표).
- 의존성: `package.json`에 `"@impact7/shared": "github:chief-impact7/impact7-shared#vX.Y.Z"` (DB/DSC/exam과 동일 태그). 폼 원본은 단일 `school`+자유텍스트 `grade`("중2")라 `studentFullLabel({ level: dscLevelFromGrade(division||grade), grade, school })`로 조립(폴백: `currentSchool`·`normalizeRealLevelGrade`가 처리).

## 배포 함정 — env 덮어쓰기
- `cloudrun/README.md`의 전체 `gcloud run deploy` 명령은 `--set-env-vars`로 `PIPELINE_VIEW_KEY`·`SURVEY_ACCESS_KEY`(+VERTEX_*) 등 운영 키를 **셸 환경변수에서 읽어 통째로 덮어쓴다.** 셸에 export 안 돼 있으면 **빈 값으로 날아가 `/pipeline`·`/survey` 접근이 깨진다.**
- **코드만 배포할 땐 env/secret/SA/scaling 플래그를 모두 생략**하라 → `gcloud run deploy ... --source=<dir> --quiet`만 쓰면 기존 리비전 설정을 **상속**(코드만 갱신).
- 배포 전 보존 확인: `gcloud run services describe newtest-chat-handler --project=gws-impact7-cli --region=asia-northeast3 --format="value(spec.template.spec.containers[0].env[].name)"` (값 비노출, 키 이름만).

## 배포처 (impact7db 아님)
- GCP 프로젝트 `gws-impact7-cli`, region `asia-northeast3`, service `newtest-chat-handler`, SA `chat-bot-sa@gws-impact7-cli.iam.gserviceaccount.com`. `--source` Cloud Build 빌드. **자동배포 없음(수동 gcloud).** Firestore는 SA키(`SA_KEY_JSON` secret)로 impact7db 접근.

**How to apply:** newtest cloudrun에 shared 로직을 더 쓸 때 위 동적 import 패턴 재사용(복사 금지). 배포는 코드 변경이면 env/secret 플래그 생략. `@impact7/shared` 버전 올릴 때 newtest 의존 태그도 같이 올려야 표기 규칙이 갈라지지 않음 — [[feedback_shared_version_conflict]]. 학교 라벨 통일 전체 맥락은 [[project_school_by_level]].
