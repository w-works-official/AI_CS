# AI CS 아키텍처

## 데이터 흐름

1. 로그인된 브라우저에서 스마트스토어 4개 채널, 지그재그 2개 채널, 에이블리 1개 채널을 확인합니다.
2. 수집 스킬이 원본을 메모리에서 정규화하고 개인정보를 마스킹합니다.
3. `source_key + content_hash`로 신규·변경·동일을 구분합니다.
4. 마스킹된 레코드만 Apps Script의 `syncRun`으로 전송합니다.
5. Apps Script가 Google Sheets의 문의, 메시지, AI 초안, 실행 기록을 각각 업서트합니다.
6. 프론트의 서버 라우트가 비밀 키를 브라우저에 노출하지 않고 Apps Script를 조회합니다.
7. 상담원은 원문, AI 추천, 사람 수정본, 쇼핑몰 실제 답변을 분리해서 확인합니다.

## 데이터 소유권

- 쇼핑몰 원문: 각 마켓 판매자센터
- 운영 데이터: Google Sheets
- 수집·정규화 규칙: `plugins/ai-cs/skills/marketplace-cs-monitor`
- 개인 플러그인 패키지: `plugins/ai-cs`
- OAuth 보호 원격 MCP: `mcp-server` 및 `/mcp`
- 조회·동기화 계약: `apps-script/Code.gs`
- 검수 UI: `app/`

## 공개 저장소에 넣지 않는 값

- 환경별 Apps Script 키
- 개발·운영 Apps Script 웹 앱 URL
- Google 계정 쿠키, 로그인 토큰, 브라우저 프로필
- 마스킹 전 고객 메시지와 주문번호
- 운영 Sheet의 원본 데이터 덤프

## 운영 상태 구분

- `NEEDS_REPLY` — 답변 필요
- `READY` — AI 추천답변 준비
- `REVIEW` — 사람 확인 필요
- `NO_REPLY_REQUIRED` — 답변 불필요
- `ANSWERED` — 쇼핑몰 실제 답변 확인

AI 초안의 `APPROVED`, `REJECTED`, `USED`는 내부 검수 상태이며 쇼핑몰 상태를 변경하지 않습니다.

## 배포

플러그인과 MCP는 `.openai/hosting.json`의 기존 Sites 프로젝트를 재사용합니다. 개발 배포와 운영 배포는 같은 저장소를 사용하더라도 서로 다른 서버 비밀값과 OAuth 클라이언트를 가져야 합니다. GitHub Pages 정적 UI는 MCP/OAuth 서버가 아니며, 비밀값이나 운영 데이터 접근 권한을 포함해서는 안 됩니다.
