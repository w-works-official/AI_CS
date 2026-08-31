import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { buildReport } from "../../plugins/ai-cs/skills/marketplace-cs-monitor/scripts/report-core.mjs";
import { loadSyncConfig, readCaseIndex, readCsData, syncReport } from "../../plugins/ai-cs/skills/marketplace-cs-monitor/scripts/sync-client.mjs";
import {
  acquireCollectorLock,
  inspectGoogleChromeSession,
  resolveBrowserSession,
} from "../../plugins/ai-cs/skills/marketplace-cs-monitor/scripts/browser-session-core.mjs";
import { detectAuthChallengeState, filterChatMessages, parseTalktalkTotalText } from "../../plugins/ai-cs/skills/marketplace-cs-monitor/scripts/collector-ui-core.mjs";

const OUTPUT_DIR = new URL("../../output/", import.meta.url);
const STORE_ORIGIN = "https://sell.smartstore.naver.com";
const ROUTES = {
  comments: `${STORE_ORIGIN}/#/comment/`,
  customerQna: `${STORE_ORIGIN}/#/naverpay/qnas`,
  customerCenter: `${STORE_ORIGIN}/#/seller/customer-center-cs`,
  talktalk: `${STORE_ORIGIN}/#/talktalk/chat`,
  zigzagOrder: "https://partners.kakaostyle.com/shop/pink-rocket/order_inquiry",
  zigzagItem: "https://partners.kakaostyle.com/shop/pink-rocket/item_question",
  ably: "https://my.a-bly.com/inquiry",
};
const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const CHANNEL_ALIASES = {
  comments: "comments",
  smartstore_comments: "comments",
  customer_qna: "customer_qna",
  smartstore_customer_qna: "customer_qna",
  customer_center: "customer_center",
  smartstore_customer_center: "customer_center",
  talktalk: "talktalk",
  smartstore_talktalk: "talktalk",
  zigzag_order_inquiry: "zigzag_order_inquiry",
  order_inquiry: "zigzag_order_inquiry",
  zigzag_item_question: "zigzag_item_question",
  item_question: "zigzag_item_question",
  ably: "ably_inquiry",
  ably_inquiry: "ably_inquiry",
};
const requestedChannels = new Set(
  String(process.env.CS_CHANNELS || "comments,customer_qna,customer_center,talktalk")
    .split(",")
    .map((value) => CHANNEL_ALIASES[compact(value)])
    .filter(Boolean),
);
const syncMode = String(process.env.CS_SYNC_MODE || "prepare").toLowerCase();

if (!requestedChannels.size) throw new Error("CS_CHANNELS에 지원 채널이 없습니다.");
if (!["prepare", "sync"].includes(syncMode)) throw new Error("CS_SYNC_MODE는 prepare 또는 sync여야 합니다.");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function selectMarketplaceProductLink(candidates, expectedName = "") {
  const allowedSuffixes = ["naver.com", "kakaostyle.com", "a-bly.com"];
  const unique = new Map();
  for (const candidate of candidates ?? []) {
    try {
      const url = new URL(candidate?.href || "");
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) continue;
      if (!/(?:product|products|goods|item)(?:\/|$)/i.test(url.pathname)) continue;
      if (!unique.has(url.href)) unique.set(url.href, { href: url.href, text: compact(candidate?.text) });
    } catch {
      // Invalid or relative candidates are discarded before the masked report is built.
    }
  }
  const links = [...unique.values()];
  const expected = compact(expectedName);
  const matched = expected
    ? links.find((item) => item.text && (item.text.includes(expected) || expected.includes(item.text)))
    : null;
  return matched || (links.length === 1 ? links[0] : null) || { href: "", text: "" };
}

async function extractMarketplaceProductLink(root, expectedName = "", selector = "a[href]") {
  const candidates = await root.locator(selector).evaluateAll((links) => links.map((link) => ({
    href: link.href || link.getAttribute("href") || "",
    text: (link.textContent || "").replace(/\s+/g, " ").trim(),
  }))).catch(() => []);
  return selectMarketplaceProductLink(candidates, expectedName);
}

function kstDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function startOfOneMonth(endDate) {
  const end = new Date(`${endDate}T00:00:00+09:00`);
  end.setDate(end.getDate() - 30);
  return kstDate(end);
}

function daysBefore(endDate, days) {
  const date = new Date(`${endDate}T00:00:00+09:00`);
  date.setDate(date.getDate() - days);
  return kstDate(date);
}

function isOpenReplyStatus(status) {
  const value = compact(status);
  if (/답변완료|처리완료|상담완료|완료|종료/.test(value)) return false;
  return /미답변|미처리|답변대기|대기|진행중|처리중/.test(value);
}

function maskName(value) {
  const text = compact(value);
  if (!text) return "";
  return `${text.slice(0, 1)}${"*".repeat(Math.max(2, text.length - 1))}`;
}

function maskId(value) {
  const text = compact(value);
  if (!text || text.includes("*")) return text;
  if (text.length <= 2) return `${text.slice(0, 1)}*`;
  return `${text.slice(0, 2)}***${text.slice(-1)}`;
}

function maskLongNumber(value) {
  const text = compact(value);
  if (!/^\d{10,}$/.test(text)) return text;
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function maskSensitiveText(value) {
  return compact(value)
    .replace(/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g, "010-****-****")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "**@***")
    .replace(/((?:상품\s*)?주문번호\s*[:：]?\s*)\d{6,}/gi, "$1[마스킹]")
    .replace(/\b\d{12,}\b/g, (number) => maskLongNumber(number))
    .replace(/(주소\s*[:：]?)[^,;]+/gi, "$1 [주소 마스킹]");
}

function normalizeDateLabel(label, endDate) {
  const text = compact(label);
  if (/^(오전|오후)/.test(text)) return endDate;
  if (text === "어제") {
    const date = new Date(`${endDate}T00:00:00+09:00`);
    date.setDate(date.getDate() - 1);
    return kstDate(date);
  }
  const match = text.match(/^(\d{1,2})월\s*(\d{1,2})일$/);
  return match ? `${endDate.slice(0, 4)}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : "";
}

function normalizeFlexibleDate(label, endDate) {
  const text = compact(label);
  const iso = text.match(/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  if (/\uC624\uB298|\uBC29\uAE08|\d+\s*(?:\uBD84|\uC2DC\uAC04)\s*\uC804|\uC624\uC804|\uC624\uD6C4|^\d{1,2}:\d{2}/.test(text)) return endDate;
  if (/\uC5B4\uC81C/.test(text)) {
    const date = new Date(`${endDate}T00:00:00+09:00`);
    date.setDate(date.getDate() - 1);
    return kstDate(date);
  }
  const md = text.match(/(?:^|\s)(\d{1,2})\s*(?:[./]|\uC6D4)\s*(\d{1,2})(?:\s*\uC77C)?/);
  return md ? `${endDate.slice(0, 4)}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}` : "";
}

async function requireLoggedIn(page) {
  await page.goto(ROUTES.talktalk, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_000);
  await assertNoAuthChallenge(page, "SMARTSTORE");
  await page.getByText("문의/리뷰관리", { exact: false }).waitFor({ state: "visible" });
}

async function assertNoAuthChallenge(page, channelLabel) {
  const visibleText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const state = detectAuthChallengeState(page.url(), visibleText.slice(0, 20_000));
  if (state) throw new Error(`${channelLabel}_${state}`);
}

async function collectComments(context, range) {
  const page = await context.newPage();
  await page.goto(ROUTES.comments, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "상세검색 노출" }).click();
  await page.getByRole("button", { name: "1개월", exact: true }).click();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.waitForTimeout(1_000);

  const expected = Number((await page.getByRole("heading", { name: /문의내역/ }).innerText()).match(/\d+/)?.[0] ?? 0);
  const records = [];
  const seenRecords = new Set();
  let pageNo = 1;

  while (records.length < expected && pageNo <= 100) {
    const cards = page.locator("ul.seller-list-border.has-thmb > li");
    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const replyCount = Number(await card.locator(".btn-area .count").textContent().catch(() => "0")) || 0;
      if (replyCount > 0) {
        for (let retry = 0; retry < 2; retry += 1) {
          await card.getByRole("button", { name: /^답글\s+\d+/ }).press("Enter").catch(() => {});
          await page.waitForTimeout(250 + retry * 250);
          if (await card.locator(".seller-reply-list > li").count()) break;
        }
      }

      const record = await card.evaluate((el) => {
        const q = (selector) => el.querySelector(selector);
        const part = q(".partition-area")?.innerText ?? "";
        const date = part.match(/(20\d{2}\.\d{2}\.\d{2}\s+\d{2}:\d{2})(?:\s+\(([^)]+)\))?/);
        return {
          status: q(".title-area .label")?.innerText?.trim() ?? "",
          secret: Boolean(q(".fn-secret1")),
          product_id: part.match(/상품번호:\s*(\d+)/)?.[1] ?? "",
          product_name: q(".title-area strong")?.innerText?.trim() ?? "",
          product_url: q(".title-area a")?.href ?? "",
          customer_id_masked: q(".partition-area .text-info")?.innerText?.trim() ?? "",
          created_at: date?.[1] ?? "",
          updated_note: date?.[2] ?? "",
          body: q(".text-area")?.innerText?.trim() ?? "",
          reply_count: Number(q(".btn-area .count")?.innerText ?? 0),
          replies: [...el.querySelectorAll(".seller-reply-list > li")].map((li) => ({
            replied_at: li.querySelector(".info-date")?.innerText?.trim() ?? "",
            body: li.querySelector(".write-area > span.write-area")?.innerText?.trim() ?? "",
          })),
        };
      });
      record.product_url = selectMarketplaceProductLink(
        [{ href: record.product_url, text: record.product_name }],
        record.product_name,
      ).href;
      const recordKey = sha256([record.product_id, record.created_at, record.customer_id_masked, record.body].join("|"));
      if (!seenRecords.has(recordKey)) {
        seenRecords.add(recordKey);
        records.push({
          ...record,
          source_url: ROUTES.comments,
          source_url_kind: "LIST",
          source_reference_masked: `SS-C-${recordKey.slice(0, 12)}`,
        });
      }
    }

    if (records.length >= expected) break;
    const next = page.getByRole("button", { name: "다음 페이지로 이동", exact: true });
    if (!(await next.count())) break;
    const nextButton = next.first();
    const canMove = await nextButton.isVisible().catch(() => false)
      && await nextButton.isEnabled({ timeout: 2_000 }).catch(() => false);
    if (!canMove) break;
    await nextButton.click({ force: true });
    await page.waitForTimeout(600);
    pageNo += 1;
  }

  await page.close();
  return {
    visibleTotal: expected,
    records: records.filter((record) => record.created_at.replaceAll(".", "-").slice(0, 10) >= range.start),
    openQueueRecords: records.filter((record) => isOpenReplyStatus(record.status)),
    openQueueComplete: records.length === expected,
    openQueueWindowStart: startOfOneMonth(range.end),
  };
}

async function collectCustomerQna(context, range) {
  const page = await context.newPage();
  await page.goto(ROUTES.customerQna, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe");
  const monthLink = frame.locator("#period_selector ._quick_month a");
  await monthLink.click({ force: true });
  await monthLink.press("Enter");
  await frame.getByLabel("처리상태").selectOption({ label: "전체" });
  const search = frame.getByRole("link", { name: "검색", exact: true });
  await search.click({ force: true });
  await search.press("Enter").catch(() => {});
  await page.waitForTimeout(1_000);

  const records = [];
  const visited = new Set();
  let paginationComplete = false;
  for (let guard = 0; guard < 20; guard += 1) {
    const activePage = Number(await frame.locator(".paginate strong").textContent().catch(() => "1")) || guard + 1;
    if (visited.has(activePage)) break;
    visited.add(activePage);
    const rows = frame.locator("table").nth(2).locator("tbody tr");
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const cells = await row.locator("td").allTextContents();
      if (cells.length < 10) continue;
      await row.locator("td").nth(4).getByRole("link").click({ force: true });
      await page.waitForTimeout(220);
      const detail = await frame.getByRole("table", { name: "고객문의 내용 보기", exact: true }).evaluate((table) => {
        const result = {};
        for (const tr of table.querySelectorAll("tr")) {
          const children = [...tr.children];
          for (let i = 0; i < children.length; i += 1) {
            if (children[i].tagName === "TH") {
              const label = children[i].innerText.trim();
              const valueCell = children[i + 1];
              result[label] = valueCell?.innerText?.trim() ?? "";
              if (/상품명/.test(label)) result.__product_url = valueCell?.querySelector("a[href]")?.href ?? "";
            }
          }
        }
        return result;
      });
      const sellerReply = await frame.getByRole("table", { name: "판매자 답변 처리", exact: true })
        .getByRole("textbox").inputValue().catch(() => "");
      const sourceIdentity = [detail["상품주문번호"] || "", compact(cells[0]), compact(cells[4])].join("|");
      const productName = detail["상품명"] || compact(cells[6]);
      const productUrl = selectMarketplaceProductLink(
        [{ href: detail.__product_url || "", text: productName }],
        productName,
      ).href;
      records.push({
        received_at: compact(cells[0]), status: compact(cells[1]), category: compact(cells[2]),
        order_no: detail["주문번호"] || compact(cells[3]), subject: compact(cells[4]),
        product_id: compact(cells[5]), product_name: productName,
        product_url: productUrl,
        source_url: ROUTES.customerQna,
        source_url_kind: "LIST",
        source_reference_masked: `SS-Q-${sha256(sourceIdentity).slice(0, 12)}`,
        customer_name: detail["질문자"] || "", customer_id_masked: detail["질문자ID"] || "",
        processed_at: compact(cells[8]), satisfaction: compact(cells[9]),
        product_order_no: detail["상품주문번호"] || "", body: detail["문의내용"] || "", seller_reply: sellerReply,
      });
    }
    const next = frame.getByRole("link", { name: "다음 ›", exact: true });
    if (!(await next.count())) {
      paginationComplete = true;
      break;
    }
    await next.click({ force: true });
    await page.waitForTimeout(600);
  }
  await page.close();
  return {
    visibleTotal: records.length,
    records: records.filter((record) => record.received_at.slice(0, 10) >= range.start),
    openQueueRecords: records.filter((record) => isOpenReplyStatus(record.status)),
    // The page currently exposes no independently verified unanswered total.
    // Keep reconciliation disabled even when pagination itself completed.
    openQueueComplete: false,
    openQueueError: paginationComplete
      ? "AUTHORITATIVE_OPEN_TOTAL_UNAVAILABLE"
      : "PAGINATION_INCOMPLETE",
    openQueueWindowStart: startOfOneMonth(range.end),
  };
}

async function collectCustomerCenter(context) {
  const page = await context.newPage();
  await page.goto(ROUTES.customerCenter, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "1개월", exact: true }).click({ force: true });
  await frame.getByRole("button", { name: "검색", exact: true }).click({ force: true });
  await page.waitForTimeout(700);
  const rows = frame.getByRole("grid").locator("tbody tr");
  const records = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const cells = await rows.nth(index).locator("td").allTextContents();
    if (cells.length >= 8) records.push({
      inquiry_id: compact(cells[0]), product_order_no: compact(cells[1]), product_id: compact(cells[2]),
      subject: compact(cells[3]), updated_at: compact(cells[4]), status: compact(cells[5]),
      last_replied_at: compact(cells[6]), last_replier: compact(cells[7]),
    });
  }
  await page.close();
  return records;
}

async function dismissTalktalkNotice(frame) {
  const dialogs = frame.locator('[role="dialog"]:visible, .layer_popup:visible, .popup_area:visible');
  for (let index = 0; index < await dialogs.count(); index += 1) {
    const dialog = dialogs.nth(index);
    const close = dialog.locator('button[aria-label="닫기"], a[aria-label="닫기"], button:text-is("닫기"), a:text-is("닫기")').first();
    if (await close.count()) await close.click({ force: true }).catch(() => {});
  }
}

async function waitForTalktalkDetail(frame, page, threadId) {
  await frame.locator(".chat_detail").waitFor({ state: "visible", timeout: 10_000 });
  const messages = frame.locator(".balloon_item._message");
  try {
    await messages.first().waitFor({ state: "attached", timeout: 5_000 });
  } catch {
    await dismissTalktalkNotice(frame);
    await page.waitForTimeout(500);
    if (!(await messages.count())) throw new Error(`TALKTALK_MESSAGES_NOT_LOADED:${threadId}`);
  }
}

async function loadTalktalkHistory(frame, page) {
  const scroller = frame.locator(".chat_reverse");
  await scroller.waitFor({ state: "visible", timeout: 5_000 });
  let previousCount = -1;
  let previousHeight = -1;
  let stablePasses = 0;

  for (let guard = 0; guard < 30 && stablePasses < 3; guard += 1) {
    const state = await scroller.evaluate((element) => {
      element.scrollTop = -element.scrollHeight;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return {
        count: element.querySelectorAll(".balloon_item._message").length,
        height: element.scrollHeight,
      };
    });
    await page.waitForTimeout(400);
    const next = await scroller.evaluate((element) => ({
      count: element.querySelectorAll(".balloon_item._message").length,
      height: element.scrollHeight,
    }));
    stablePasses = next.count === previousCount && next.height === previousHeight
      && state.count === next.count && state.height === next.height
      ? stablePasses + 1
      : 0;
    previousCount = next.count;
    previousHeight = next.height;
  }
}

async function extractTalktalkMessages(frame) {
  const messages = await frame.locator(".balloon_item._message").evaluateAll((items) => items.map((item) => {
    const area = item.querySelector(".balloon_area") ?? item;
    const styleNode = area.matches("[data-balloon-style]") ? area : area.querySelector("[data-balloon-style]");
    const text = (
      area.querySelector("._copy_area")?.textContent
      ?? area.querySelector(".title_content")?.textContent
      ?? area.querySelector(".balloon_text")?.textContent
      ?? area.querySelector(".system_message_text")?.textContent
      ?? ""
    ).replace(/\s+/g, " ").trim();
    const imageCount = area.querySelectorAll("img").length;
    const sourceMessageId = [...item.classList].find((className) => /^_msgId\d+$/.test(className)) ?? "";
    return {
      source_message_id: sourceMessageId,
      direction: item.classList.contains("my_msg") ? "seller" : item.classList.contains("other_msg") ? "customer" : "system",
      type: styleNode?.getAttribute("data-balloon-style") ?? "",
      text: text || (imageCount ? "첨부 이미지" : ""),
      time: item.querySelector(".status_time")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      image_count: imageCount,
    };
  }));
  return filterChatMessages(messages);
}

async function extractTalktalkProduct(frame, expectedName) {
  const candidates = await frame
    .locator('a[href*="smartstore.naver.com"][href*="/product"], a[href*="brand.naver.com"][href*="/product"]')
    .evaluateAll((links) => links.map((el) => ({
      href: el.href || el.getAttribute("href") || "",
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
    })))
    .catch(() => []);
  const unique = [...new Map(candidates.filter((item) => item.href).map((item) => [item.href, item])).values()];
  const expected = compact(expectedName);
  const matched = expected
    ? unique.find((item) => item.text.includes(expected) || expected.includes(item.text))
    : null;
  const selected = matched || (unique.length === 1 ? unique[0] : null);
  return selected || { href: "", text: "" };
}

async function readTalktalkTotal(frame) {
  const candidates = [
    frame.getByRole("button", { name: /^전체/ }),
    frame.getByRole("tab", { name: /^전체/ }),
    frame.locator('button, a, [role="button"], [role="tab"]').filter({ hasText: /^\s*전체(?:\s|\(|\[|$)/ }),
  ];
  for (const locator of candidates) {
    const texts = await locator.allTextContents().catch(() => []);
    for (const text of texts) {
      const parsed = parseTalktalkTotalText(text);
      if (parsed !== null) return { total: parsed, authoritative: true };
    }
  }
  return {
    total: await frame.locator('a[href*="/chat/ct/"]').count(),
    authoritative: false,
  };
}

async function loadTalktalkList(frame, page, expected) {
  const links = frame.locator('a[href*="/chat/ct/"]');
  const listCandidates = frame.locator("ul.list_chat_result.scroll_vertical, ul.list_chat_result, [class*='list_chat_result']");
  let previousCount = -1;
  let stablePasses = 0;
  for (let guard = 0; guard < 100 && stablePasses < 3; guard += 1) {
    const count = await links.count();
    if (expected.authoritative && count >= expected.total) break;
    stablePasses = count === previousCount ? stablePasses + 1 : 0;
    previousCount = count;
    if (stablePasses >= 3) break;
    const list = listCandidates.first();
    if (await list.count() && await list.isVisible().catch(() => false)) {
      await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    } else if (count > 0) {
      await links.nth(count - 1).scrollIntoViewIfNeeded().catch(() => {});
    }
    await page.waitForTimeout(350);
  }
  return links.count();
}

async function collectTalktalk(context, range) {
  const page = await context.newPage();
  await page.goto(ROUTES.talktalk, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe");
  await dismissTalktalkNotice(frame);
  const requestedDays = Math.floor((Date.parse(`${range.end}T00:00:00+09:00`) - Date.parse(`${range.start}T00:00:00+09:00`)) / 86_400_000) + 1;
  const oneWeek = frame.getByRole("button", { name: "최근 1주일", exact: true });
  await oneWeek.waitFor({ state: "visible", timeout: 10_000 });
  if (requestedDays > 7) {
    await oneWeek.click({ force: true });
    const oneMonth = frame.getByRole("button", { name: /^(최근\s*)?1개월$/, exact: true });
    if (!(await oneMonth.count())) throw new Error("TALKTALK_ONE_MONTH_FILTER_NOT_FOUND");
    await oneMonth.first().click({ force: true });
  }
  await page.waitForTimeout(700);
  const expected = await readTalktalkTotal(frame);
  await loadTalktalkList(frame, page, expected);

  const listRowsRaw = await frame.locator('a[href*="/chat/ct/"]').evaluateAll((links) => links.map((el) => {
    const rawHref = el.getAttribute("href") ?? "";
    const absoluteHref = el.href || rawHref;
    const productLink = el.querySelector('.chat_info_bottom a[href], [class*="product"] a[href]');
    return {
      href: rawHref,
      source_url: absoluteHref,
      thread_id: rawHref.split("/").pop()?.split(/[?#]/)[0] ?? "",
      customer_name: el.querySelector(".text_name")?.innerText?.trim() ?? "",
      tag: el.querySelector('[aria-label="태그"]')?.innerText?.trim() ?? "",
      time_label: el.querySelector(".chat_info_time")?.innerText?.trim() ?? "",
      unread_count: Number(el.querySelector(".badge_alarm")?.innerText ?? 0),
      preview: el.querySelector(".text_message")?.innerText?.trim() ?? "",
      product: el.querySelector(".chat_info_bottom")?.innerText?.replace(/^문의 내역처/, "").trim() ?? "",
      product_url: productLink?.href ?? "",
    };
  }));
  const listRows = [...new Map(listRowsRaw.filter((row) => row.thread_id).map((row) => [row.thread_id, row])).values()];

  const records = [];
  for (const meta of listRows.filter((row) => normalizeDateLabel(row.time_label, range.end) >= range.start)) {
    await frame.locator(`a[href="${meta.href}"]`).click({ force: true });
    await waitForTalktalkDetail(frame, page, meta.thread_id);
    await loadTalktalkHistory(frame, page);
    const messages = await extractTalktalkMessages(frame);
    if (!messages.length) throw new Error(`TALKTALK_EMPTY_CONVERSATION:${meta.thread_id}`);
    const productDetail = await extractTalktalkProduct(frame, meta.product);
    records.push({
      ...meta,
      source_url: meta.source_url,
      source_url_kind: "EXACT",
      source_reference_masked: `TT-${sha256(meta.thread_id).slice(0, 12)}`,
      product: meta.product || productDetail.text,
      product_url: meta.product_url || productDetail.href,
      message_date: normalizeDateLabel(meta.time_label, range.end),
      messages,
      last_actor: messages.at(-1)?.direction ?? "unknown",
    });
  }
  await page.close();
  return records;
}

async function collectZigzagTable(context, range, channel) {
  const isOrder = channel === "order_inquiry";
  const route = isOrder ? ROUTES.zigzagOrder : ROUTES.zigzagItem;
  const detailPattern = isOrder ? /\/order_inquiry\/detail\/(\d+)/ : /\/item_question\/detail\/(\d+)/;
  const page = await context.newPage();
  try {
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1_200);
    await assertNoAuthChallenge(page, `ZIGZAG_${channel.toUpperCase()}`);
    await page.getByRole("tab").first().waitFor({ state: "visible", timeout: 10_000 });

    const tabTexts = await page.getByRole("tab").allTextContents();
    const visibleTotal = Number(compact(tabTexts.find((text) => /^\uC804\uCCB4/.test(compact(text)))).match(/\d+/)?.[0] ?? 0);
    const openVisibleTotal = Number(compact(tabTexts.find((text) => /\uBBF8\uB2F5\uBCC0/.test(compact(text)))).match(/\d+/)?.[0] ?? 0);
    const table = page.locator("table.pds-table").first();
    await table.waitFor({ state: "visible", timeout: 10_000 });
    const rows = table.locator("tbody tr");
    const zeroState = (await rows.count()) === 1 && (await rows.first().locator(".pds-table-cell-empty").count()) > 0;
    if (zeroState) return {
      visibleTotal,
      records: [],
      verifiedZero: true,
      openVisibleTotal,
      openQueueRecords: [],
      openQueueComplete: openVisibleTotal === 0,
      openQueueWindowStart: daysBefore(range.end, 7),
    };

    const records = [];
    const rowCount = await rows.count();
    const routePath = new URL(route).pathname;
    for (let index = 0; index < rowCount; index += 1) {
      if (new URL(page.url()).pathname !== routePath) {
        await page.goto(route, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(700);
      }
      const row = page.locator("table.pds-table tbody tr").nth(index);
      const cells = (await row.locator("td").allTextContents()).map(compact);
      if (cells.length < 9) continue;
      const occurredDate = normalizeFlexibleDate(cells[5], range.end);
      const status = cells[0];
      if (occurredDate && occurredDate < range.start && !isOpenReplyStatus(status)) continue;

      const contentButton = row.locator("td").nth(4).getByRole("button").first();
      if (!(await contentButton.count())) continue;
      await contentButton.click();
      await page.waitForURL(detailPattern, { timeout: 15_000 });
      await page.waitForTimeout(700);
      const sourceId = page.url().match(detailPattern)?.[1] ?? "";
      if (!sourceId) throw new Error(`ZIGZAG_DETAIL_ID_MISSING:${channel}:${index}`);

      let sellerReplies = [];
      const replyNodes = page.locator('[class*="InquiryReply"]');
      for (let replyIndex = 0; replyIndex < await replyNodes.count(); replyIndex += 1) {
        const reply = replyNodes.nth(replyIndex);
        const text = compact(await reply.locator('[class*="Content"]').first().innerText().catch(() => ""));
        if (!text) continue;
        sellerReplies.push({
          text,
          at: compact(await reply.locator('[class*="Date"]').first().innerText().catch(() => "")),
        });
      }
      sellerReplies = filterChatMessages(sellerReplies);
      const productTexts = (await page.locator('[class*="StyledProductDetailCard"] span.pds-text').allTextContents().catch(() => [])).map(compact).filter(Boolean);
      const productName = productTexts.find((text) => !/^\d+$/.test(text)) || "";
      const productLink = await extractMarketplaceProductLink(
        page,
        productName,
        '[class*="StyledProductDetailCard"] a[href], a[href*="/product/"], a[href*="/products/"], a[href*="/goods/"], a[href*="/item/"]',
      );
      const inquiryText = cells[4];
      records.push({
        source_id: sourceId,
        source_url: page.url(),
        source_url_kind: "EXACT",
        source_reference_masked: `${isOrder ? "ZZ-O" : "ZZ-I"}-${sha256(sourceId).slice(0, 12)}`,
        status,
        category: cells[3],
        created_at: cells[5],
        occurred_at: occurredDate || cells[5],
        due_reply_at: cells[6],
        customer_name: cells[7],
        customer_id: cells[8],
        order_no: isOrder ? cells[2] : "",
        fulfillment_type: isOrder ? "" : cells[2],
        subject: inquiryText,
        body: inquiryText,
        product_name: productName,
        product_id: productTexts.find((text) => /^\d{4,}$/.test(text)) || "",
        product_url: productLink.href,
        messages: filterChatMessages([{ direction: "customer", at: cells[5], text: inquiryText, image_count: 0 }]),
        seller_replies: sellerReplies,
        last_actor: sellerReplies.length || /\uB2F5\uBCC0\s*\uC644\uB8CC|\uC644\uB8CC/.test(status) ? "seller" : "customer",
      });
    }
    const openQueueRecords = records.filter((record) => isOpenReplyStatus(record.status));
    return {
      visibleTotal,
      records,
      verifiedZero: false,
      openVisibleTotal,
      openQueueRecords,
      // Only the current table page is collected. Do not close older cases until
      // a full pagination walk proves this is a complete unanswered snapshot.
      openQueueComplete: false,
      openQueueError: openQueueRecords.length === openVisibleTotal
        ? "PAGINATION_COMPLETENESS_UNPROVEN"
        : "OPEN_TOTAL_MISMATCH",
      openQueueWindowStart: daysBefore(range.end, 7),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function collectAbly(context, range) {
  const page = await context.newPage();
  try {
    await page.goto(ROUTES.ably, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await assertNoAuthChallenge(page, "ABLY");
    const outerFrame = page.locator("iframe#seller-admin-iframe");
    await outerFrame.waitFor({ state: "visible", timeout: 10_000 });
    const frame = outerFrame.contentFrame();
    const progressTab = frame.getByRole("tab", { name: "\uC9C4\uD589\uC911", exact: true });
    const completedTab = frame.getByRole("tab", { name: "\uC644\uB8CC", exact: true });
    const records = [];
    let visibleTotal = 0;
    let openVisibleTotal = 0;
    const openQueueRecords = [];
    let openQueueComplete = true;

    for (const tab of [
      { locator: progressTab, status: "\uC9C4\uD589\uC911" },
      { locator: completedTab, status: "\uC644\uB8CC" },
    ]) {
      await tab.locator.click();
      await page.waitForTimeout(900);
      const totalTexts = await frame.getByText(/^\uCD1D\s*\d+\s*\uAC74$/, { exact: false }).allTextContents().catch(() => []);
      const tabVisibleTotal = Number(compact(totalTexts[0]).match(/\d+/)?.[0] ?? 0);
      visibleTotal += tabVisibleTotal;
      const cards = frame.locator('[class*="InquiryCard__Wrapper"]');
      const renderedCardMetas = await cards.evaluateAll((roots) => roots.map((root) => {
        const texts = [...root.querySelectorAll("p")].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
        const badges = [...root.querySelectorAll(".mantine-Badge-label")].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
        const roomLabel = badges.find((text) => /\uBB38\uC758\uBC29\s*\uBC88\uD638/.test(text)) ?? "";
        return {
          customer_name: texts[0] ?? "",
          time_label: texts[1] ?? "",
          preview: texts[2] ?? "",
          category: badges.find((text) => text !== roomLabel) ?? "",
          room_label: roomLabel,
          room_id: roomLabel.match(/\d+/)?.[0] ?? "",
        };
      })).catch(() => []);
      const cardMetas = [...new Map(
        renderedCardMetas.filter((meta) => meta.room_id).map((meta) => [meta.room_id, meta]),
      ).values()];
      const cardCount = cardMetas.length;
      if (tab.status === "\uC9C4\uD589\uC911") {
        openVisibleTotal = tabVisibleTotal;
        openQueueComplete = cardCount === tabVisibleTotal;
      }
      for (const meta of cardMetas) {
        if (!meta.room_id) continue;
        const occurredDate = normalizeFlexibleDate(meta.time_label, range.end);
        if (tab.status !== "\uC9C4\uD589\uC911" && occurredDate && occurredDate < range.start) continue;

        const card = frame.locator('[class*="InquiryCard__Wrapper"]').filter({ hasText: meta.room_label }).first();
        if (!(await card.count())) {
          if (tab.status === "\uC9C4\uD589\uC911") openQueueComplete = false;
          continue;
        }
        await card.getByText(/\uBB38\uC758\uBC29\s*\uBC88\uD638/, { exact: false }).first().click();
        await page.waitForTimeout(850);
        const chatFrame = frame.locator('iframe[class*="InquiryChat__Iframe"]').first().contentFrame();
        await chatFrame.locator("body").waitFor({ state: "visible", timeout: 10_000 });
        const extractedMessages = await chatFrame.locator("p.typography__body1.color__black, p.typography__body1.color__white").evaluateAll((items) => items.map((el) => {
          let root = el.parentElement;
          let time = "";
          let imageCount = 0;
          for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
            const timeNode = root.querySelector("p.typography__body5.color__content_tertiary");
            if (timeNode) {
              time = (timeNode.textContent ?? "").replace(/\s+/g, " ").trim();
              imageCount = root.querySelectorAll("img").length;
              break;
            }
          }
          return {
            direction: el.classList.contains("color__white") ? "seller" : "customer",
            text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
            at: time,
            image_count: imageCount,
          };
        }));
        const messages = filterChatMessages(extractedMessages);
        const productTexts = (await frame.locator('[class*="StyledProductDetailCard"] span.pds-text').allTextContents().catch(() => [])).map(compact).filter(Boolean);
        const productName = productTexts.find((text) => !/^\d+$/.test(text)) || "";
        const productLink = await extractMarketplaceProductLink(
          frame,
          productName,
          '[class*="StyledProductDetailCard"] a[href], [class*="InquiryInfo"] a[href], a[href*="/product/"], a[href*="/products/"], a[href*="/goods/"], a[href*="/item/"]',
        );
        const collectedRecord = {
          room_id: meta.room_id,
          source_url: ROUTES.ably,
          source_url_kind: "LIST",
          source_reference_masked: `AB-${sha256(meta.room_id).slice(0, 12)}`,
          status: tab.status,
          category: meta.category,
          customer_name: meta.customer_name,
          occurred_at: occurredDate || meta.time_label,
          preview: meta.preview,
          product_name: productName,
          product_id: productTexts.find((text) => /^\d{4,}$/.test(text)) || "",
          product_url: productLink.href,
          messages,
          last_actor: messages.at(-1)?.direction || (tab.status === "\uC644\uB8CC" ? "seller" : "customer"),
        };
        records.push(collectedRecord);
        if (tab.status === "\uC9C4\uD589\uC911") openQueueRecords.push(collectedRecord);
      }
    }
    await progressTab.click().catch(() => {});
    return { visibleTotal, records, openVisibleTotal, openQueueRecords, openQueueComplete };
  } finally {
    await page.close().catch(() => {});
  }
}

function maskRecord(channel, record) {
  const masked = structuredClone(record);
  if ("customer_name" in masked) masked.customer_name_masked = maskName(masked.customer_name), delete masked.customer_name;
  if ("customer_id_masked" in masked) masked.customer_id_masked = maskId(masked.customer_id_masked);
  if ("order_no" in masked) masked.order_no = maskLongNumber(masked.order_no);
  if ("product_order_no" in masked) masked.product_order_no = maskLongNumber(masked.product_order_no);
  for (const field of ["body", "seller_reply", "preview", "subject", "updated_note"]) {
    if (field in masked) masked[field] = maskSensitiveText(masked[field]);
  }
  if (Array.isArray(masked.replies)) masked.replies = masked.replies.map((reply) => ({ ...reply, body: maskSensitiveText(reply.body) }));
  if (Array.isArray(masked.messages)) masked.messages = masked.messages.map((message) => ({ ...message, text: maskSensitiveText(message.text) }));
  if ("customer_name" in record && channel === "talktalk") masked.customer_name_masked = maskName(record.customer_name), delete masked.customer_name;
  masked.content_hash = sha256(JSON.stringify(masked));
  return masked;
}

function toCsv(rows) {
  const flat = rows.map(({ channel, record }) => ({
    channel,
    occurred_at: record.created_at || record.received_at || record.message_date || record.updated_at || "",
    status: record.status || "",
    category: record.category || record.tag || "",
    customer: record.customer_id_masked || record.customer_name_masked || "",
    product_id: record.product_id || "",
    product_name: record.product_name || record.product || "",
    subject: record.subject || "",
    body_or_preview: record.body || record.preview || "",
    seller_reply: record.seller_reply || record.replies?.map((r) => r.body).join(" | ") || "",
    message_count: record.messages?.length || "",
    image_count: record.messages?.reduce((sum, message) => sum + message.image_count, 0) || "",
    content_hash: record.content_hash,
  }));
  const headers = Object.keys(flat[0] ?? { channel: "" });
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [headers.map(quote).join(","), ...flat.map((row) => headers.map((header) => quote(row[header])).join(","))].join("\n");
}

const browserSession = await resolveBrowserSession();
await inspectGoogleChromeSession(browserSession);
const releaseCollectorLock = await acquireCollectorLock();
try {
const browser = await chromium.connectOverCDP(browserSession.cdp_url);
const context = browser.contexts()[0];
if (!context) throw new Error("CDP Chrome context를 찾지 못했습니다.");
const smartstoreRequested = ["comments", "customer_qna", "customer_center", "talktalk"].some((channel) => requestedChannels.has(channel));
if (smartstoreRequested) {
  const probe = await context.newPage();
  try {
    await requireLoggedIn(probe);
  } finally {
    await probe.close().catch(() => {});
  }
}

const end = process.env.CS_END_DATE || kstDate();
const range = { start: process.env.CS_START_DATE || startOfOneMonth(end), end };
const collectedAt = new Date().toISOString();
const [comments, customerQna, customerCenter, talktalk, zigzagOrder, zigzagItem, ably] = await Promise.all([
  requestedChannels.has("comments") ? collectComments(context, range) : Promise.resolve({ visibleTotal: 0, records: [], openQueueRecords: [], openQueueComplete: false }),
  requestedChannels.has("customer_qna") ? collectCustomerQna(context, range) : Promise.resolve({ visibleTotal: 0, records: [], openQueueRecords: [], openQueueComplete: false }),
  requestedChannels.has("customer_center") ? collectCustomerCenter(context) : Promise.resolve([]),
  requestedChannels.has("talktalk") ? collectTalktalk(context, range) : Promise.resolve([]),
  requestedChannels.has("zigzag_order_inquiry") ? collectZigzagTable(context, range, "order_inquiry") : Promise.resolve({ visibleTotal: 0, records: [], openQueueRecords: [], openQueueComplete: false }),
  requestedChannels.has("zigzag_item_question") ? collectZigzagTable(context, range, "item_question") : Promise.resolve({ visibleTotal: 0, records: [], openQueueRecords: [], openQueueComplete: false }),
  requestedChannels.has("ably_inquiry") ? collectAbly(context, range) : Promise.resolve({ visibleTotal: 0, records: [], openQueueRecords: [], openQueueComplete: false }),
]);

const rawCollection = {
  schema_version: 1,
  mode: process.env.CS_RUN_MODE || "collect_and_reconcile",
  range,
  collected_at: collectedAt,
  duration_ms: Date.now() - new Date(collectedAt).getTime(),
  channels: {
    smartstore_comments: {
      market: "smartstore", channel: "comments", attempted: requestedChannels.has("comments"),
      visible_total: comments.visibleTotal, records: comments.records,
      open_queue_scope: "one_month_unanswered", open_queue_window_start: comments.openQueueWindowStart,
      open_queue_visible_total: comments.openQueueRecords.length, open_queue_records: comments.openQueueRecords,
      open_queue_complete: requestedChannels.has("comments") && comments.openQueueComplete,
    },
    smartstore_customer_qna: {
      market: "smartstore", channel: "customer_qna", attempted: requestedChannels.has("customer_qna"),
      visible_total: customerQna.visibleTotal, records: customerQna.records,
      open_queue_scope: "one_month_unanswered", open_queue_window_start: customerQna.openQueueWindowStart,
      open_queue_visible_total: customerQna.openQueueRecords.length, open_queue_records: customerQna.openQueueRecords,
      open_queue_complete: requestedChannels.has("customer_qna") && customerQna.openQueueComplete,
      open_queue_error: customerQna.openQueueError || "",
    },
    smartstore_customer_center: { market: "smartstore", channel: "customer_center", attempted: requestedChannels.has("customer_center"), visible_total: customerCenter.length, records: customerCenter },
    smartstore_talktalk: {
      market: "smartstore",
      channel: "talktalk",
      attempted: requestedChannels.has("talktalk"),
      visible_total: talktalk.length,
      read_state_transition_count: talktalk.filter((record) => Number(record.unread_count ?? 0) > 0).length,
      records: talktalk,
    },
    zigzag_order_inquiry: {
      market: "zigzag", channel: "order_inquiry", attempted: requestedChannels.has("zigzag_order_inquiry"),
      visible_total: zigzagOrder.visibleTotal, records: zigzagOrder.records,
      open_queue_scope: "one_week_unanswered", open_queue_window_start: zigzagOrder.openQueueWindowStart,
      open_queue_visible_total: zigzagOrder.openVisibleTotal, open_queue_records: zigzagOrder.openQueueRecords,
      open_queue_complete: requestedChannels.has("zigzag_order_inquiry") && zigzagOrder.openQueueComplete,
      open_queue_error: zigzagOrder.openQueueError || "",
    },
    zigzag_item_question: {
      market: "zigzag", channel: "item_question", attempted: requestedChannels.has("zigzag_item_question"),
      visible_total: zigzagItem.visibleTotal, records: zigzagItem.records,
      open_queue_scope: "one_week_unanswered", open_queue_window_start: zigzagItem.openQueueWindowStart,
      open_queue_visible_total: zigzagItem.openVisibleTotal, open_queue_records: zigzagItem.openQueueRecords,
      open_queue_complete: requestedChannels.has("zigzag_item_question") && zigzagItem.openQueueComplete,
      open_queue_error: zigzagItem.openQueueError || "",
    },
    ably_inquiry: {
      market: "ably", channel: "inquiry", attempted: requestedChannels.has("ably_inquiry"),
      visible_total: ably.visibleTotal, records: ably.records,
      open_queue_scope: "all_in_progress", open_queue_window_start: "",
      open_queue_visible_total: ably.openVisibleTotal, open_queue_records: ably.openQueueRecords,
      open_queue_complete: requestedChannels.has("ably_inquiry") && ably.openQueueComplete,
    },
  },
};
let syncConfig = null;
let previousRecords = [];
let caseIndexStatus = "UNAVAILABLE";
try {
  const candidateConfig = await loadSyncConfig();
  if (candidateConfig.web_app_url && candidateConfig.api_key && candidateConfig.environment === "development") {
    const health = await readCsData("health", {}, candidateConfig);
    if (health.environment !== "development" || health.auto_send !== false || Number(health.marketplace_write_actions || 0) !== 0) {
      throw new Error("UNSAFE_DEVELOPMENT_HEALTH");
    }
    previousRecords = await readCaseIndex(candidateConfig);
    caseIndexStatus = "AVAILABLE";
    syncConfig = candidateConfig;
  }
} catch (error) {
  if (syncMode === "sync") throw error;
}
const report = buildReport(rawCollection, previousRecords);
report.summary.case_index_status = caseIndexStatus;
let syncResult = { skipped: true, reason: "PREPARE_ONLY" };
if (syncMode === "sync") {
  syncConfig = syncConfig || await loadSyncConfig();
  if (syncConfig.environment !== "development") throw new Error("DEVELOPMENT_SYNC_REQUIRED");
  const health = await readCsData("health", {}, syncConfig);
  if (health.environment !== "development" || health.auto_send !== false || Number(health.marketplace_write_actions || 0) !== 0) {
    throw new Error("UNSAFE_DEVELOPMENT_HEALTH");
  }
  syncResult = await syncReport(report, syncConfig, {
    model: process.env.CS_AI_MODEL || "Codex",
    promptVersion: process.env.CS_PROMPT_VERSION || "marketplace-cs-monitor-v1",
  });
}

let maskedOutput = "";
if (process.env.CS_KEEP_MASKED_OUTPUT === "1" || syncMode === "prepare") {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = collectedAt.replaceAll(/[:.]/g, "-");
  const outputUrl = new URL(`marketplace-cs-${stamp}.json`, OUTPUT_DIR);
  await writeFile(outputUrl, JSON.stringify(report, null, 2), "utf8");
  maskedOutput = decodeURIComponent(outputUrl.pathname).replace(/^\/(?:([A-Za-z]:))/, "$1");
}
console.log(JSON.stringify({ browser_session: { source: browserSession.source, label: browserSession.session_label }, range, channels: [...requestedChannels], summary: report.summary, masked_output: maskedOutput, sync: syncResult }, null, 2));
} finally {
  await releaseCollectorLock();
}
// connectOverCDP 대상은 사용자가 로그인해 둔 Chrome이므로 Browser.close()를 호출하지 않는다.
// 다음 이벤트 루프에서 프로세스만 종료해 Chrome 세션과 열린 탭을 보존한다.
setImmediate(() => process.exit(0));
