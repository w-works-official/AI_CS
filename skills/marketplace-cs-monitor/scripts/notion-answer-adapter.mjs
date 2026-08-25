const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const ACK = /^(네|넵|네네|넹|예|확인|확인했습니다|알겠습니다|감사|감사합니다|고맙습니다|아하|아 네|좋아요|네 감사합니다)$/;

function unwrap(value) {
  if (typeof value !== "string") return "";
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.text === "string" ? parsed.text : value;
  } catch {
    return value;
  }
}

function extractProperties(pageText) {
  const match = unwrap(pageText).match(/<properties>\s*({[\s\S]*?})\s*<\/properties>/);
  if (!match) return {};
  try { return JSON.parse(match[1]); } catch { return {}; }
}

function cleanMessageBody(block) {
  const fenced = [...String(block).matchAll(/```(?:plain text|text)?\s*\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  return compact(fenced.join("\n").replace(/\[이미지 메시지\]/g, ""));
}

function section(text, headingPattern) {
  const match = String(text).match(new RegExp(`##\\s+(?:${headingPattern})\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`));
  return match?.[1] ?? "";
}

export function parseMessageFlow(pageText) {
  const text = unwrap(pageText);
  const messages = [];
  const pattern = /###\s+\d+\.\s+(고객|판매자)(?:\s*·\s*([^\n]+))?\s*\n([\s\S]*?)(?=\n###\s+\d+\.|\n<\/content>|$)/g;
  for (const match of text.matchAll(pattern)) {
    const direction = match[1] === "고객" ? "customer" : "seller";
    const body = cleanMessageBody(match[3]);
    const imageCount = Number(match[3].match(/첨부 이미지:\s*(\d+)개/)?.[1] ?? 0);
    messages.push({ direction, at: compact(match[2]), text: body, image_count: imageCount });
  }
  return messages;
}

function groupTurns(messages) {
  const turns = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (previous?.direction === message.direction) {
      if (message.text) previous.texts.push(message.text);
      previous.image_count += message.image_count || 0;
      if (message.at) previous.at = message.at;
    } else {
      turns.push({ direction: message.direction, at: message.at, texts: message.text ? [message.text] : [], image_count: message.image_count || 0 });
    }
  }
  return turns.map((turn) => ({ ...turn, text: compact(turn.texts.join("\n")) }));
}

function meaningfulQuestion(text) {
  const value = compact(text).replace(/[.!~♡♥️😊🙂]+/g, "");
  return value.length >= 4 && !ACK.test(value) && !/^\[?이미지/.test(value);
}

function meaningfulAnswer(text) {
  const value = compact(text).replace(/[.!~♡♥️😊🙂]+/g, "");
  return value.length >= 10 && !ACK.test(value) && !/^(안녕하세요|고객님 안녕하세요)$/.test(value);
}

export function notionPageToAnswerRecords(pageText, row = {}) {
  const unwrapped = unwrap(pageText);
  const properties = extractProperties(pageText);
  const messages = parseMessageFlow(pageText);
  const turns = groupTurns(messages);
  const records = [];

  for (let index = 0; index < turns.length - 1; index += 1) {
    const customer = turns[index];
    const seller = turns[index + 1];
    if (customer.direction !== "customer" || seller.direction !== "seller") continue;
    if (!meaningfulQuestion(customer.text) || !meaningfulAnswer(seller.text)) continue;

    const sourceKey = compact(row.source_key ?? properties["원본키"] ?? properties.url ?? row.url);
    records.push({
      market: "smartstore",
      channel: compact(row.channel ?? properties["채널"]),
      source_key: `${sourceKey}:pair:${records.length + 1}`,
      reply_state: "ANSWERED",
      pii_scan: "PASS",
      category: compact(row.category ?? properties["분류"]),
      product_name: compact(row.product_name ?? properties["상품명"]),
      occurred_at: compact(row.occurred_at ?? properties["date:발생일:start"]),
      messages: [{ direction: "customer", at: customer.at, text: customer.text, image_count: customer.image_count }],
      seller_replies: [{ at: seller.at, text: seller.text }],
      notion_url: compact(properties.url ?? row.url),
    });
  }

  if (!records.length) {
    const question = cleanMessageBody(section(unwrapped, "문의 내용"));
    const answer = cleanMessageBody(section(unwrapped, "기존 답변|판매자 답변"));
    if (meaningfulQuestion(question) && meaningfulAnswer(answer)) {
      const sourceKey = compact(row.source_key ?? properties["원본키"] ?? properties.url ?? row.url);
      records.push({
        market: "smartstore",
        channel: compact(row.channel ?? properties["채널"]),
        source_key: `${sourceKey}:pair:1`,
        reply_state: "ANSWERED",
        pii_scan: "PASS",
        category: compact(row.category ?? properties["분류"]),
        product_name: compact(row.product_name ?? properties["상품명"]),
        occurred_at: compact(row.occurred_at ?? properties["date:발생일:start"]),
        messages: [{ direction: "customer", text: question }],
        seller_replies: [{ text: answer }],
        notion_url: compact(properties.url ?? row.url),
      });
    }
  }

  return { properties, messages, turns, records };
}
