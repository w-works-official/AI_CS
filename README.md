# AI CS Review Desk

스마트스토어, 지그재그/카카오스타일, 에이블리 문의를 읽기 전용으로 수집하고 사람 답변과 AI 추천답변을 분리해 검수하는 CS 운영 도구입니다.

## 포함된 구성

- `app/` — 상담원용 AI 답변 검수 프론트와 서버 프록시
- `apps-script/` — Google Sheets 기반 조회·동기화·AI 초안 검토 API
- `plugins/ai-cs/` — 개인용 ChatGPT/Codex 플러그인 패키지와 `marketplace-cs-monitor` 스킬
- `mcp-server/` — OAuth로 보호되는 원격 HTTP MCP와 제한된 Apps Script 도구
- `docs/marketplace-cs-monitor-manual.md` — 실행 모드와 추천 프롬프트
- `docs/ARCHITECTURE.md` — 데이터 흐름, 안전 경계, 배포 구조
- `docs/CLAUDE-CODE.md` — Claude Code 포팅 범위와 설치 체크리스트
- `github-pages/` — 공개 GitHub Pages 프론트 진입점
- `.github/workflows/pages.yml` — `main` 변경 시 GitHub Pages 자동 배포

## 공개 페이지

- GitHub Pages: <https://w-works-official.github.io/AI_CS/>
- 공개 정적 프론트에는 API 키나 시트 ID를 포함하지 않습니다.
- 마스킹된 CS 데이터는 읽기 전용 프록시를 통해 조회합니다.

## 안전 경계

- 마켓 답변 자동 전송 없음
- 상담완료, 주문변경, 취소, 환불, 교환 자동화 없음
- 톡톡 상세 확인에 따른 미읽음→읽음 전환만 허용하고 별도 집계
- 저장 전 고객·주문 식별 정보 마스킹
- 사람 답변과 AI 초안을 별도 데이터로 보관
- `AUTO_SEND`는 항상 비활성화

## 로컬 실행

필요 조건은 Node.js 22.13 이상과 pnpm입니다.

```bash
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

`.env.local`에는 실제 Apps Script 웹 앱 URL과 `CS_API_KEY`에 대응하는 키를 입력합니다. 실제 키와 운영 URL은 Git에 커밋하지 않습니다.

## 검증

```bash
pnpm build
pnpm lint
node apps-script/Code.contract.test.cjs
node plugins/ai-cs/skills/marketplace-cs-monitor/scripts/report-core.test.mjs
node plugins/ai-cs/skills/marketplace-cs-monitor/scripts/answer-library-core.test.mjs
node plugins/ai-cs/skills/marketplace-cs-monitor/scripts/notion-answer-adapter.test.mjs
node plugins/ai-cs/skills/marketplace-cs-monitor/scripts/sync-client.test.mjs
```

## Codex 스킬 설치

플러그인 전체 설치가 아닌 레거시 단일 스킬 설치가 필요할 때만 아래 폴더를 복사합니다.

```powershell
Copy-Item -Recurse -Force .\plugins\ai-cs\skills\marketplace-cs-monitor "$env:USERPROFILE\.codex\skills\marketplace-cs-monitor"
```

설치 후 Codex에서 `마켓플레이스 CS 모니터 스킬로 오늘 변화분을 수집해줘`처럼 요청할 수 있습니다.

## 환경 설정

Google Apps Script 설정과 시트 계약은 [apps-script/README.md](apps-script/README.md)를 참고하세요. 전체 구조는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)에 정리되어 있습니다.
