# Claude Code 포팅 안내

Claude Code는 `SKILL.md`, 참고 파일, 실행 스크립트로 구성된 Agent Skills를 지원하므로 핵심 구조와 Node.js 로직은 재사용할 수 있습니다.

## 필요한 변경

1. `plugins/ai-cs/skills/marketplace-cs-monitor` 전체를 `~/.claude/skills/marketplace-cs-monitor/`에 복사합니다.
2. `chrome:control-chrome` 지시를 Claude in Chrome의 `claude --chrome` 또는 `/chrome` 흐름으로 바꿉니다.
3. Codex 절대 경로 예시를 `${CLAUDE_SKILL_DIR}` 기준으로 바꿉니다.
4. 노션을 사용할 경우 Claude Code에 Notion MCP를 연결합니다.
5. `/marketplace-cs-monitor`로 호출하고 로그인된 Chrome에서 7개 채널을 다시 검증합니다.

## 현재 검증 상태

- Agent Skills 형식 호환: 확인
- Node.js 정규화·마스킹 테스트: 확인
- Claude용 브라우저 도구명과 경로 변환: 미적용
- Claude in Chrome 실수집: 미검증
- Claude에서 Apps Script 동기화: 미검증

따라서 현재 저장소의 스킬은 Codex 설치본이며 Claude용 완성본으로 표시하지 않습니다.

## 공식 문서

- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/chrome
- https://code.claude.com/docs/en/mcp
