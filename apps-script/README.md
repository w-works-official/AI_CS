# Pink Rocket CS Apps Script API

환경별 Google Sheet에 연결하는 읽기, 마스킹된 수집 결과 업서트, 검증된 사람답변 검색, AI 초안 검토 API입니다. 개발 배포는 테스트 Sheet만 사용하고 운영 배포만 승인 후 `Pink Rocket CS 운영 데이터 v1`을 사용합니다.

## 안전 경계

- 마켓 답변 전송 기능 없음
- `syncRun`은 마켓에서 읽어 마스킹한 결과만 저장하며 `case_key + content_hash`로 변경 상태를 서버에서 다시 판정
- 완전하고 건수가 일치하는 미답변 목록 스냅샷만 과거 상태를 대조하며, 1회 미노출은 `REVIEW`, 2회 연속 미노출은 로컬 `CLOSED`로 기록
- `CLOSED`는 검수 DB 상태일 뿐 쇼핑몰 문의를 종료하지 않으며 원문·메시지·과거 초안은 삭제하지 않음
- 사람 답변과 AI 초안은 각각 `02_MESSAGES`, `03_AI_DRAFTS`에 분리
- 원문·상품 링크는 `https`와 판매자센터 허용 도메인만 저장하며 토큰·세션·전화번호·이메일이 URL에 포함되면 동기화를 거부
- `source_url_kind`는 개별 문의 `EXACT`, 목록 화면 `LIST`, 미수집 `UNAVAILABLE`을 구분하고 목록 링크는 개별 문의 링크처럼 표시하지 않음
- AI 초안의 `APPROVED`, `REJECTED`, `USED`는 검토 상태일 뿐 마켓 응답 상태를 바꾸지 않음
- 모든 응답에 `auto_send: false` 유지

## 설치

1. Google Sheet에서 `확장 프로그램 → Apps Script`를 엽니다.
2. `Code.gs`와 `appsscript.json` 내용을 각각 붙여넣습니다.
3. 연결형 프로젝트이면 별도 스프레드시트 ID가 필요 없습니다.
4. 독립형 프로젝트이면 스크립트 속성 `CS_SPREADSHEET_ID`에 대상 Sheet ID를 설정합니다.
5. 개발 배포는 `CS_ENVIRONMENT=development`, 운영 배포는 `CS_ENVIRONMENT=production`을 설정합니다.
6. 모든 요청에 필요한 별도 `CS_API_KEY`를 설정합니다. 키가 없으면 GET과 POST 모두 거부됩니다.
7. 운영 배포에만 `CS_PRODUCTION_ENABLED=true`를 설정합니다.
8. `03_AI_DRAFTS`에 사람 수정본을 AI 원문과 분리하는 `human_revision` 열을 추가합니다.
9. `01_CASES`의 링크 열(`source_url_kind`, `source_reference`, `product_url`, `product_thumbnail_url`, `image_count`)은 첫 안전 동기화 때 자동으로 추가됩니다.
10. 배포 URL과 키는 MCP 서버의 환경별 비밀값으로 등록합니다. 로컬 Windows 사용자 환경이나 프롬프트에서 읽지 않습니다.

## 읽기 요청

서버 클라이언트는 키가 URL이나 접근 로그에 남지 않도록 `Content-Type: text/plain` POST JSON으로 읽기 요청을 보냅니다. 지원 작업은 `health`, `overview`, `cases`, `case`, `answerLibrary`입니다. `answerLibrary`는 `enabled=TRUE`, `quality_state=USE`, `pii_scan=PASS`인 사람답변만 최대 3개 반환합니다. 레거시 진단용 GET도 인증과 환경 검사를 동일하게 적용합니다.

## POST

`Content-Type: text/plain`로 JSON을 전송합니다.

마스킹된 수집 보고서 업서트:

```json
{
  "action": "syncRun",
  "environment": "development",
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

동일한 `run_id` 재요청은 중복 기록을 만들지 않습니다. `source_key` 누락·중복, `content_hash` 누락, 마스킹되지 않은 전화번호나 이메일은 거부합니다. 새 보고서의 `source_url`, `source_url_kind`, `source_reference`, `product_url`, `product_thumbnail_url`, 메시지별 `image_count`는 `01_CASES` 조회 결과까지 왕복하며, 링크 필드가 없는 과거 레코드는 기존 값 또는 채널 목록 주소를 유지합니다.

AI 초안 검토:

```json
{
  "action": "reviewDraft",
  "environment": "development",
  "draft_id": "...",
  "draft_state": "APPROVED",
  "review_note": "검토 완료",
  "human_revision": "사람이 검토하고 수정한 별도 문장",
  "api_key": "required"
}
```

`APPROVED`, `REJECTED`, `USED` 외 상태 변경과 마켓 답변 전송은 허용되지 않습니다.
