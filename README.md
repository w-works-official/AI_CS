# AI CS Review Desk

스마트스토어, 지그재그/카카오스타일, 에이블리 문의를 읽기 전용으로 수집하고 사람 답변과 AI 추천답변을 분리해 검수하는 CS 운영 도구입니다.

## 포함된 구성

- `app/` — 상담원용 AI 답변 검수 프론트와 서버 프록시
- `apps-script/` — Google Sheets 기반 조회·동기화·AI 초안 검토 API
- `skills/marketplace-cs-monitor/` — Codex용 마켓플레이스 수집 스킬, 정규화·마스킹·답변 참고 로직과 테스트
- `docs/marketplace-cs-monitor-manual.md` — 실행 모드와 추천 프롬프트
- `docs/ARCHITECTURE.md` — 데이터 흐름, 안전 경계, 배포 구조
- `docs/CLAUDE-CODE.md` — Claude Code 포팅 범위와 설치 체크리스트

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
node skills/marketplace-cs-monitor/scripts/report-core.test.mjs
node skills/marketplace-cs-monitor/scripts/answer-library-core.test.mjs
node skills/marketplace-cs-monitor/scripts/notion-answer-adapter.test.mjs
node skills/marketplace-cs-monitor/scripts/sync-client.test.mjs
```

## Codex 스킬 설치

`skills/marketplace-cs-monitor` 폴더 전체를 Windows 사용자 전역 스킬 폴더에 복사합니다.

```powershell
Copy-Item -Recurse -Force .\skills\marketplace-cs-monitor "$env:USERPROFILE\.codex\skills\marketplace-cs-monitor"
```

설치 후 Codex에서 `마켓플레이스 CS 모니터 스킬로 오늘 변화분을 수집해줘`처럼 요청할 수 있습니다.

## 환경 설정

Google Apps Script 설정과 시트 계약은 [apps-script/README.md](apps-script/README.md)를 참고하세요. 전체 구조는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)에 정리되어 있습니다.

