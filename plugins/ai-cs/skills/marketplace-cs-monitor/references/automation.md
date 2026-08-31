# Recurring collection and draft generation

Recurring runs stay disabled until a manual seven-channel QA has passed. Do not register a Windows task or Codex automation merely because this reference exists.

## Recommended execution owner

Use a Codex heartbeat automation for the complete workflow because AI draft generation requires the model after Playwright collection. A Windows Task Scheduler entry can run the macro, but by itself it can only collect, mask, reconcile, and sync; it cannot create grounded AI drafts without adding a separate paid model/API credential.

The heartbeat must run in this existing local task and project, reuse the registered CS Chrome session, and call the installed `marketplace-cs-monitor` skill. It must not create a browser, select a profile, scan ports, or enter credentials. If Chrome is absent, logged out, challenged, or already locked by another run, report the condition and stop safely.

## Suggested prompt

> `marketplace-cs-monitor` 스킬로 등록된 CS Chrome을 재사용하여 오늘 신규·변경 문의를 수집해. `collect_and_reconcile`과 prepare 모드로 수집·마스킹한 뒤, development case index와 비교하고, `NEEDS_REPLY` 문의에는 검증 답변을 최대 3개 검색해 AI 추천답변을 생성·PII 검사해. 답변이 있는 문의는 운영 상태를 바꾸지 말고 EVAL 초안을 만들지 마. health 안전조건을 확인한 후 development 대상에 한 번만 동기화하고, 쇼핑몰 쓰기 0건과 채널별 실패를 보고해. 인증 화면, CAPTCHA, 2단계 인증, 계정 확인, 불완전 open snapshot에서는 중단하거나 해당 채널의 완료 재조정을 건너뛰어.`

## Scheduling guardrails

- Initial cadence: every 15 minutes during agreed business hours. Move to five minutes only after duration and failure-rate evidence show runs do not overlap.
- One collector per PC; an existing lock means skip, never force-unlock.
- Keep `CS_SYNC_MODE=prepare` through draft generation. Perform exactly one final sync.
- Never include raw inquiry text, source URLs, secrets, or authentication state in automation logs.
- TalkTalk unread-to-read count is reported separately; every marketplace write-action counter remains zero.
- Authentication expiry is a user-action notice, not an automatic login attempt.
- Do not enable recurring execution until the user explicitly asks to activate it.
