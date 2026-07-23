import * as cheerio from "cheerio";
import type { ParsedFields } from "./index.js";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
};

const SARAMIN_ORIGIN = "https://www.saramin.co.kr";

export interface SaraminDetailBody {
  text: string;
  imageUrls: string[];
}

export function extractSaraminRecIdx(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const fromQuery = parsed.searchParams.get("rec_idx");
    if (fromQuery) return fromQuery;

    const pathMatch = parsed.pathname.match(/\/(\d{5,})(?:\/|$)/);
    if (pathMatch) return pathMatch[1];

    return null;
  } catch {
    return null;
  }
}

export async function fetchSaraminDetailHtml(
  recIdx: string,
  refererUrl: string,
  timeoutMs = 10000
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://www.saramin.co.kr/zf_user/jobs/relay/view-ajax?rec_idx=${encodeURIComponent(recIdx)}`,
      {
        signal: controller.signal,
        headers: {
          ...FETCH_HEADERS,
          Referer: refererUrl.split("#")[0],
        },
      }
    );

    if (!response.ok) return "";
    return response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function resolveIframeUrl(src: string): string {
  if (src.startsWith("http")) return src;
  if (src.startsWith("//")) return `https:${src}`;
  if (src.startsWith("/")) return `${SARAMIN_ORIGIN}${src}`;
  return `${SARAMIN_ORIGIN}/${src}`;
}

function resolveImageUrl(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http")) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return `${SARAMIN_ORIGIN}${trimmed}`;
  return trimmed;
}

function extractDetailIframeUrl(ajaxHtml: string): string | null {
  const $ = cheerio.load(ajaxHtml);
  const src = $("iframe#iframe_content_0, iframe.iframe_content").first().attr("src");
  return src ? resolveIframeUrl(src) : null;
}

/** 이미지형 공고의 SEO용 숨김 텍스트(display:none / 0px)는 본문으로 보지 않는다. */
function removeHiddenSeoNodes(
  $: cheerio.CheerioAPI,
  scope: ReturnType<cheerio.CheerioAPI>
) {
  scope.find("*").each((_, el) => {
    const style = (($(el).attr("style") ?? "") + "").toLowerCase().replace(/\s+/g, "");
    if (
      style.includes("display:none") ||
      style.includes("visibility:hidden") ||
      (style.includes("overflow:hidden") &&
        (style.includes("height:0") ||
          style.includes("fontsize:0") ||
          style.includes("linewidth:0")))
    ) {
      $(el).remove();
    }
  });
}

function extractUserContent(html: string): SaraminDetailBody {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const content = $(".user_content").first();
  const scope = content.length ? content : $("body");

  const imageUrls: string[] = [];
  scope.find("img").each((_, el) => {
    const raw =
      $(el).attr("src") ||
      $(el).attr("data-src") ||
      $(el).attr("data-original") ||
      $(el).attr("data-lazy-src") ||
      "";
    const src = resolveImageUrl(raw);
    if (/^https?:/.test(src) && !imageUrls.includes(src)) {
      imageUrls.push(src);
    }
  });

  // 이미지 URL은 유지한 뒤, 숨김 SEO 텍스트만 제거한다.
  removeHiddenSeoNodes($, scope);

  scope.find("br").replaceWith("\n");
  scope.find("p, div, li, tr, h1, h2, h3, h4, h5, h6").each((_, el) => {
    $(el).append("\n");
  });

  const text = scope
    .text()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, imageUrls };
}

/**
 * 상세요강(B 영역)은 view-ajax 응답 내부의 iframe(view-detail)에 별도로
 * 로드된다. 이 iframe 본문을 가져와 텍스트/이미지를 추출한다.
 */
export async function fetchSaraminDetailBody(
  ajaxHtml: string,
  refererUrl: string,
  timeoutMs = 10000
): Promise<SaraminDetailBody> {
  const iframeUrl = extractDetailIframeUrl(ajaxHtml);
  if (!iframeUrl) return { text: "", imageUrls: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(iframeUrl, {
      signal: controller.signal,
      headers: {
        ...FETCH_HEADERS,
        Referer: refererUrl.split("#")[0],
      },
    });

    if (!response.ok) return { text: "", imageUrls: [] };
    return extractUserContent(await response.text());
  } catch {
    return { text: "", imageUrls: [] };
  } finally {
    clearTimeout(timer);
  }
}

function textOrEmpty($: cheerio.CheerioAPI, selector: string): string {
  return $(selector).first().text().replace(/\s+/g, " ").trim();
}

function getDtDdValue($: cheerio.CheerioAPI, label: string): string {
  let value = "";
  $("dt").each((_, dt) => {
    const dtLabel = $(dt).text().replace(/\s+/g, " ").trim();
    if (dtLabel.startsWith(label)) {
      value = $(dt).next("dd").text().replace(/\s+/g, " ").trim();
    }
  });
  return value;
}

function parseDeadline(raw: string): string | null {
  const match = raw.match(/(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// 상시/수시채용은 신호값 "상시채용"으로 남기고, 저장 직전에 status로 변환한다.
function isRecurringDeadline(raw: string): boolean {
  return /상시|수시|채용\s*시|충원\s*시|채용시\s*마감/.test(raw);
}

function normalizeDeadlineRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (isRecurringDeadline(trimmed)) return "상시채용";
  return trimmed;
}

function cleanDetailText(text: string): string {
  return text
    .replace(/자격요건상세보기|우대사항상세보기|제출서류 보기/g, " ")
    .replace(/\d+건/g, " ")
    .replace(/닫기|관심기업|채용중 \d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSectionText($: cheerio.CheerioAPI, heading: string): string {
  let text = "";
  $("h2.jv_title, h2.jv_title_heading").each((_, el) => {
    const title = $(el).text().replace(/\s+/g, " ").trim();
    if (title === heading) {
      const clone = $(el).closest(".jv_cont").find(".cont").first().clone();
      clone.find("script, style, noscript").remove();
      text = clone.text().replace(/\s+/g, " ").trim();
    }
  });
  return cleanDetailText(text);
}

function buildSaraminRawText(
  $: cheerio.CheerioAPI,
  fields: Omit<ParsedFields, "raw_text">,
  detailBody?: SaraminDetailBody
): string {
  const sections: string[] = [];

  if (fields.company_name) sections.push(`[기업명] ${fields.company_name}`);
  if (fields.job_title) sections.push(`[채용공고] ${fields.job_title}`);

  const summary = extractSectionText($, "핵심 정보");
  if (summary) sections.push(`[핵심 정보]\n${summary}`);

  // 상세요강(B 영역)은 iframe 본문에서 가져온다. 텍스트가 없고 이미지로만
  // 등록된 공고는 이미지 URL을 스냅샷에 남긴다.
  const detailText = detailBody?.text?.trim() ?? "";
  const detailImages = detailBody?.imageUrls ?? [];
  if (detailText) {
    sections.push(`[상세요강]\n${detailText}`);
  } else {
    const fallbackDetail = extractSectionText($, "상세요강");
    if (fallbackDetail) sections.push(`[상세요강]\n${fallbackDetail}`);
  }
  if (detailImages.length > 0) {
    sections.push(`[상세요강 이미지]\n${detailImages.join("\n")}`);
  }

  if (fields.qualifications) {
    sections.push(`[자격요건]\n${fields.qualifications}`);
  }
  if (fields.preferences) {
    sections.push(`[우대사항]\n${fields.preferences}`);
  }

  const benefit = extractSectionText($, "복리후생");
  if (benefit) sections.push(`[복리후생]\n${benefit}`);

  const howto = extractSectionText($, "접수기간 및 방법");
  if (howto) sections.push(`[접수기간 및 방법]\n${howto}`);

  if (fields.industry) {
    sections.push(`[기업정보]\n업종: ${fields.industry}`);
  }

  const composed = sections.join("\n\n").trim();
  if (composed) return composed.slice(0, 50000);

  return `${fields.company_name} ${fields.job_title} ${fields.qualifications} ${fields.preferences}`.trim();
}

export function parseSaraminDetail(
  html: string,
  url: string,
  detailBody?: SaraminDetailBody
): ParsedFields {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const company_name = textOrEmpty($, ".company_name");
  const job_title = textOrEmpty($, "h1.tit_job");
  const recruitment_field = job_title;
  const qualifications = cleanDetailText(getDtDdValue($, "자격요건"));
  const preferences = cleanDetailText(getDtDdValue($, "우대사항"));
  const industry = cleanDetailText(getDtDdValue($, "업종"));
  const deadline_raw = normalizeDeadlineRaw(getDtDdValue($, "마감일"));
  const application_method = getDtDdValue($, "지원방법");
  const required_documents = cleanDetailText(getDtDdValue($, "접수양식"));

  // 담당업무(job_description)는 LLM이 원문(raw_text)에서 분류해 채운다.
  // 규칙 기반으로는 공고마다 형식이 달라 본문을 정확히 나눌 수 없기 때문에
  // 여기서는 비워 두고, 요약 메타데이터는 raw_text 스냅샷에만 남긴다.
  const job_description = "";

  const baseFields = {
    company_name,
    job_title,
    recruitment_field,
    job_description,
    qualifications,
    preferences,
    industry,
    deadline_raw,
    deadline_date: parseDeadline(deadline_raw),
    required_documents,
    application_method,
  };

  const raw_text = buildSaraminRawText($, baseFields, detailBody);

  return {
    ...baseFields,
    raw_text,
  };
}

export function hasSaraminDetailContent(fields: ParsedFields): boolean {
  return Boolean(
    fields.company_name.trim() &&
      fields.job_title.trim() &&
      (fields.qualifications.trim() || fields.preferences.trim())
  );
}
