# Chat 연동 (DWD) 상세

선생님들의 Google Chat 학생 언급을 학생 종합 리포트에 포함하는 연동. 클라이언트: `functions-shared/src/chatClient.js`.

## 구조 (동기화 + 인덱스 조회)

리포트마다 풀스캔하던 것을 단계 6에서 동기화로 전환했다:
- **`syncChatMessages`** (onSchedule 하루 04:00, `CHAT_SA_KEY` secret): `sync_state/chat_messages`의 `last_synced_time` 이후 신규 메시지를 chief 스페이스에서 증분 수집 → 재원생(`isEnrollableStatus`) 이름 매칭 → `chat_messages`에 `student_names[]` 태깅 적재. 첫 실행은 3일 소급, 전체 2000건 상한.
- **`generateStudentReportAi`**: `chat_messages` `where student_names array-contains name orderBy create_time desc limit 20` (복합 인덱스). secret 불필요(admin SDK). 조회 실패는 graceful.
- 이름 매칭: 번호 포함 고유 전제, 정규식 `escapeRegex(name)+'(?![0-9])'`로 '김민준3'≠'김민준30'.

### ⚠️ Chat API Configuration 필수 (함정)

Chat API enable만으로는 부족하다. **Cloud Console → Google Chat API → Configuration 탭에서 Chat app(App name·Avatar URL·Description)을 채우고 저장**해야 `spaces.list`가 `Chat app not found` 없이 동작한다(DWD user 인증이어도 프로젝트에 Chat app 구성이 필요). graceful이 이 에러를 삼키면 조용히 0건이 되므로, 동기화 함수는 throw로 두어 에러를 드러낸다.

## 인증 (Domain-Wide Delegation)

- 서비스 계정 `chat-reader@impact7db.iam.gserviceaccount.com`이 **`chief@impact7.kr`를 가장(impersonate)**해 chief가 멤버인 스페이스를 읽는다.
- SA 키는 Secret Manager `CHAT_SA_KEY`에 저장(로컬 키 미보관). 런타임 SA에 `secretAccessor` 부여됨.
- DWD 클라이언트 ID: `118119896494799775142`
- DWD 스코프: `chat.spaces.readonly`, `chat.messages.readonly` (Admin Console → 도메인 전체 위임에 등록)
- 가장 계정을 바꾸려면 `chatClient.js`의 `IMPERSONATE` + Admin Console DWD 멤버십 확인.

## 동작

- `google-auth-library`의 `JWT({ email, key, scopes, subject: IMPERSONATE })`로 토큰 발급
- `spaces.list`(멤버 스페이스) → 각 스페이스 `messages.list`(최근 45일) → `text.includes(학생이름)` 매칭
- 상한: 스페이스당 300 메시지, 학생당 20건 수집

## 함정 (반드시 준수)

- **`orderBy`는 대문자 `createTime DESC`**. 소문자 `desc`/snake_case는 400 INVALID_ARGUMENT → graceful이 삼켜 **조용히 항상 0건**이 된다. 변경 시 DWD 환경에서 실제 1회 스모크 검증.
- **graceful skip**: `CHAT_SA_KEY` 없거나 호출 실패 시 Chat 없이 나머지 분석 진행. 실패는 `console.warn`만 남으므로, 활성 상태에서 `chat_mention_count`가 계속 0이면 함수 로그를 확인한다.
- **PII**: Chat 원문(최대 200자)은 Gemini 프롬프트로만 전달, Firestore엔 `chat_mention_count`만 저장(본문 비영속). SA 키·메시지 본문을 로그/에러에 노출 금지.
- **이름 매칭 오탐**: `text.includes(name)`은 동명이인·부분문자열("김민" ⊂ "김민준") 오탐 가능. 프롬프트에 "동명이인 가능성 주의" 문구로 완화. 2자 미만 이름은 수집 제외.

## 비용 한계 → 단계 6에서 해결

리포트 1건마다 chief 전 스페이스 풀스캔이라 느림. 동기화(Firestore 적재) 최적화는 `roadmap.md` 단계 6 참조.

## 스모크 검증 절차 (DWD/스코프 변경 후)

1. DSC에서 학생 1명 [AI 생성]
2. `student_status_summaries/{학생}`의 `chat_mention_count` 확인 (>0이면 작동)
3. 0이면: `gcloud functions logs read generateStudentReportAi --region=asia-northeast3 --project=impact7db --limit=20 | grep -i chat`
