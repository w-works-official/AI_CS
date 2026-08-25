# Pink Rocket CS Apps Script API

Google Sheet `Pink Rocket CS 운영 데이터 v1`에 연결하는 읽기, 마스킹된 수집 결과 업서트, AI 초안 검토 API입니다.

## 안전 경계

- 마켓 답변 전송 기능 없음
- `syncRun`은 마켓에서 읽어 마스킹한 결과만 저장하며 `case_key + content_hash`로 변경 상태를 서버에서 다시 판정
- 사람 답변과 AI 초안은 각각 `02_MESSAGES`, `03_AI_DRAFTS`에 분리
- AI 초안의 `APPROVED`, `REJECTED`, `USED`는 검토 상태일 뿐 마켓 응답 상태를 바꾸지 않음
- 모든 응답에 `auto_send: false` 유지

## 설치

1. Google Sheet에서 `확장 프로그램 → Apps Script`를 엽니다.
2. `Code.gs`와 `appsscript.json` 내용을 각각 붙여넣습니다.
3. 연결형 프로젝트이면 별도 스프레드시트 ID가 필요 없습니다.
4. 독립형 프로젝트이면 스크립트 속성 `CS_SPREADSHEET_ID`에 대상 Sheet ID를 설정합니다.
5. 스크립트 속성 `CS_API_KEY`를 설정해야 모든 POST 요청이 허용됩니다.
6. 웹 앱 배포 URL은 로컬 환경변수 `MARKETPLACE_CS_SYNC_URL`, 같은 키는 `MARKETPLACE_CS_SYNC_KEY`에 설정합니다.

## GET

- `?action=health`
- `?action=overview`
- `?action=cases&reply_state=NEEDS_REPLY&limit=50&cursor=0`
- `?action=case&case_key=...`

## POST

`Content-Type: text/plain`로 JSON을 전송합니다.

마스킹된 수집 보고서 업서트:

```json
{
  "action": "syncRun",
  "run_id": "SYNC_...",
  "report": {
    "schema_version": 1,
    "summary": { "marketplace_write_actions": 0 },
    "channels": {},
    "records": []
  },
  "api_key": "required"
}
```

동일한 `run_id` 재요청은 중복 기록을 만들지 않습니다. `source_key` 누락·중복, `content_hash` 누락, 마스킹되지 않은 전화번호나 이메일은 거부합니다.

AI 초안 검토:

```json
{
  "action": "reviewDraft",
  "draft_id": "...",
  "draft_state": "APPROVED",
  "review_note": "검토 완료",
  "api_key": "required"
}
```

`APPROVED`, `REJECTED`, `USED` 외 상태 변경과 마켓 답변 전송은 허용되지 않습니다.
