# Marketplace channel extraction

Lock the route, selected filter, visible total, sort, and date range before collecting details.

## Smartstore

| Channel key | Route | Stable list/detail signal |
|---|---|---|
| `smartstore_comments` | `https://sell.smartstore.naver.com/#/comment/` | `ul.seller-list-border.has-thmb > li`; `.title-area`, `.partition-area`, `.text-area`, `.text-info` |
| `smartstore_customer_qna` | `https://sell.smartstore.naver.com/#/naverpay/qnas` | iframe `#__delegate`; tables `고객문의 내용 보기`, `판매자 답변 처리` |
| `smartstore_customer_center` | `https://sell.smartstore.naver.com/#/seller/customer-center-cs` | iframe `#mg-iframe`; grid rows and visible zero-state |
| `smartstore_talktalk` | `https://sell.smartstore.naver.com/#/talktalk/chat` | iframe `#__talktalk`; `a[href*="/chat/ct/"]`; message nodes `[role="heading"][aria-level="5"][data-balloon-style="text"]` |

For TalkTalk, the closest `.balloon_item` class `my_msg` is seller and `other_msg` is customer. Read `[aria-label="읽지 않은 메시지 갯수"]` before opening the detail when possible. This installation authorizes opening a nonzero unread conversation even if the marketplace changes it to read. Count observed or conservatively estimated transitions in `read_state_transition_count`; no reply, completion, tag, memo, or order action is authorized.

## Zigzag / KakaoStyle

### 주문 문의

- Route: `https://partners.kakaostyle.com/shop/pink-rocket/order_inquiry`.
- Unanswered route: append `?reply_status=not_replied`.
- Tabs expose authoritative one-week counts: `전체 N 건/1주`, `미답변 N 건/1주`, `답변완료 N 건/1주`.
- The list is newest-first and each card exposes status, category, subject, `등록일시`, `처리기한`, and a masked customer ID.
- Click the exact subject only after confirming it belongs to the target card. The detail route becomes `/order_inquiry/detail/<numeric-id>`; use that numeric ID as `source_id`.
- Detail fields include buttons named `주문정보: <id>` and `상품주문정보: <id>`, customer, product/option, existing answer, and answer timestamp.
- Never interact with `답글을 입력해주세요.`, `답변하기`, or edit controls.

### 상품 문의

- Route: `https://partners.kakaostyle.com/shop/pink-rocket/item_question`.
- Tabs expose the same one-week counts.
- List cards expose status, `상품`, subject, `등록일시`, `처리기한`, and masked customer ID.
- Click the exact subject only after confirming the target. The detail route becomes `/item_question/detail/<numeric-id>`; use that numeric ID as `source_id`.
- Detail fields expose subject, registered/deadline times, masked customer ID, product, fulfillment type, existing replies, and reply timestamps.
- Do not toggle `미답변만 보기` or use answer/edit controls unless the run explicitly requires a read-only filter and the prior state is restored.

Do not depend on generated `css-*` class names. Prefer roles, exact visible labels, route IDs, and nearby text structure.

## ABLY

- Route: `https://my.a-bly.com/inquiry`.
- Outer frame: `iframe#seller-admin-iframe`.
- Tabs: `진행중`, `완료`. Record each tab's `총 N건`, date range, and sort.
- Inquiry cards can be scoped by a class containing `InquiryCard__Wrapper` and must contain one `문의방 번호 : <number>`. Use that number as `source_id`.
- A card exposes customer, latest timestamp, latest preview, category, and inquiry-room number.
- Clicking the exact inquiry-room label opens the detail panel without leaving the route.
- The selected panel exposes the masked heading, category, room number, and a nested conversation iframe. Read the nested iframe's message sequence and preserve customer/seller/automatic-response direction when identifiable.
- The `상담 정보` panel exposes current product number/name and inquiry history.
- Never click `문의 종료하기`, send buttons, answer textboxes, file upload, phone, or memo controls.

For `changes_today`, read both `진행중` and `완료` lists because a record completed today is still a change. Stop scanning a newest-first completed list after the date becomes earlier than the locked start date.

## Zero states and failures

A zero is valid only when the same view visibly reports zero for the locked filter:

- Zigzag: selected tab count and `문의가 없어요.`
- ABLY: `총 0건` plus the matching `진행중 문의가 없어요` or completed zero-state.
- Smartstore: the matching heading/count and empty grid/list.

Selector failure, login redirect, and a verified zero-state are separate outcomes.
