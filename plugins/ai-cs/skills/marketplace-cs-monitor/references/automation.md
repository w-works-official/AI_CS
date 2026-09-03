# Recurring collection and draft generation

Recurring runs stay disabled until a manual seven-channel QA has passed. Do not register a Windows task or Codex automation merely because this reference exists.

## Recommended execution owner

Use a Codex heartbeat automation for the complete workflow because AI draft generation requires the model after Playwright collection. A Windows Task Scheduler entry can run the macro, but by itself it can only collect, mask, reconcile, and sync; it cannot create grounded AI drafts without adding a separate paid model/API credential.

The heartbeat must run in this existing local task and project, reuse the registered CS Chrome session, and call the installed `marketplace-cs-monitor` skill. It must not create a browser, select a profile, scan ports, or enter credentials. If Chrome is absent, logged out, challenged, or already locked by another run, report the condition and stop safely.

## Suggested prompt

> `marketplace-cs-monitor` 스킬로 등록된 CS Chrome을 재사용하여 오늘 신규·변경 문의를 채널 순서대로 수집해. 채널마다 `collect_and_reconcile`과 prepare 모드로 수집·마스킹 캡처한 뒤 development D1 case index와 비교하고, `NEEDS_REPLY` 문의에는 D1의 검증 답변을 최대 3개 검색해 AI 추천답변을 생성·PII 검사해. 해당 채널의 D1 health 안전조건을 확인하고 즉시 동기화·체크포인트한 뒤 다음 채널로 넘어가. 답변이 있는 문의는 운영 상태를 바꾸지 말고 EVAL 초안을 만들지 마. 전체 실행 시간 제한은 두지 말되 개별 화면 대기는 유한하게 유지하고, 실패 채널을 실행 중 수정하지 말고 오류를 기록한 뒤 다음 독립 채널로 진행해. 쇼핑몰 쓰기 0건과 채널별 실패를 보고해. 인증 화면, CAPTCHA, 2단계 인증, 계정 확인, 불완전 open snapshot에서는 해당 채널의 동기화 또는 완료 재조정을 건너뛰어.`

## Scheduling guardrails

- Initial cadence: every 15 minutes during agreed business hours. Move to five minutes only after duration and failure-rate evidence show runs do not overlap.
- One collector per PC; an existing lock means skip, never force-unlock.
- Keep `CS_SYNC_MODE=prepare` through draft generation. Perform exactly one logical sync per completed channel; transport batching is allowed only for the bounded screenshot payload.
- Do not run an infinite Node watcher. Each heartbeat owns one finite seven-channel cycle and exits; the next heartbeat starts the next cycle.
- Never include raw inquiry text, source URLs, secrets, or authentication state in automation logs.
- TalkTalk unread-to-read count is reported separately; every marketplace write-action counter remains zero.
- Authentication expiry is a user-action notice, not an automatic login attempt.
- Do not enable recurring execution until the user explicitly asks to activate it.
