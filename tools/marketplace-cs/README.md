# Marketplace CS local collector

검증된 `marketplace-cs-monitor` Playwright 수집 매크로의 저장소용 실행본입니다. 사용자가 지정해 시작한 전용 Google Chrome 프로필의 CDP 세션만 사용하며, Whale이나 다른 Chrome 프로필로 자동 전환하지 않습니다.

## 실행

1. Node.js 22 이상과 패키지를 설치합니다. Playwright 브라우저 다운로드는 필요하지 않습니다.
2. `marketplace-cs-monitor`의 `CS Chrome 시작` 절차로 전용 Chrome을 실행하고 판매자센터 로그인을 확인합니다.
3. 사용자 환경변수에 development D1 동기화 키가 이미 등록되어 있을 때만 동기화를 사용합니다. URL과 키를 명령줄이나 저장소에 넣지 않습니다.
4. 저장소 루트에서 `npm run collect:cs`를 실행합니다.

채널을 제한하려면 실행 프로세스의 `CS_CHANNELS`에 쉼표 목록을 지정합니다. 지원 값은 `comments`, `customer_qna`, `customer_center`, `talktalk`, `zigzag_order_inquiry`, `zigzag_item_question`, `ably_inquiry`입니다.

수집기는 DOM 텍스트를 우선 사용하고 로그인·CAPTCHA·추가 인증 화면에서는 중단합니다. 모든 결과는 마스킹 및 중복 판정 후 development D1에 한 번만 동기화되며 쇼핑몰 답변 입력·전송·상태 변경은 수행하지 않습니다. Apps Script는 수집 동기화 경로에 사용하지 않습니다.
