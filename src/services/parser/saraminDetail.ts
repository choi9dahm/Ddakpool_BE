import * as cheerio from "cheerio";
import type { ParsedFields } from "./index.js";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
};

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
  fields: Omit<ParsedFields, "raw_text">
): string {
  const sections: string[] = [];

  if (fields.company_name) sections.push(`[기업명] ${fields.company_name}`);
  if (fields.job_title) sections.push(`[채용공고] ${fields.job_title}`);

  const summary = extractSectionText($, "핵심 정보");
  if (summary) sections.push(`[핵심 정보]\n${summary}`);

  const detail = extractSectionText($, "상세요강");
  if (detail) sections.push(`[상세요강]\n${detail}`);

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

export function parseSaraminDetail(html: string, url: string): ParsedFields {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const company_name = textOrEmpty($, ".company_name");
  const job_title = textOrEmpty($, "h1.tit_job");
  const recruitment_field = job_title;
  const qualifications = cleanDetailText(getDtDdValue($, "자격요건"));
  const preferences = cleanDetailText(getDtDdValue($, "우대사항"));
  const industry = cleanDetailText(getDtDdValue($, "업종"));
  const deadline_raw = getDtDdValue($, "마감일");
  const application_method = getDtDdValue($, "지원방법");
  const required_documents = cleanDetailText(getDtDdValue($, "접수양식"));

  const summaryParts = ["경력", "학력", "근무형태", "급여", "근무지역"]
    .map((label) => {
      const value = getDtDdValue($, label);
      return value ? `${label}: ${value}` : "";
    })
    .filter(Boolean);

  const job_description = summaryParts.join(" | ");

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

  const raw_text = buildSaraminRawText($, baseFields);

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
