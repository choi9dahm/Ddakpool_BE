import * as cheerio from "cheerio";
import { fetchRenderedPage } from "./pageReader.js";
import {
  extractSaraminRecIdx,
  fetchSaraminDetailBody,
  fetchSaraminDetailHtml,
  hasSaraminDetailContent,
  parseSaraminDetail,
} from "./saraminDetail.js";
import {
  extractJobkoreaGno,
  fetchJobkoreaDetailBody,
  hasJobkoreaDetailContent,
  parseJobkoreaDetail,
} from "./jobkoreaDetail.js";

export interface ParsedFields {
  company_name: string;
  job_title: string;
  recruitment_field: string;
  job_description: string;
  qualifications: string;
  preferences: string;
  industry: string;
  deadline_raw: string;
  deadline_date: string | null;
  required_documents: string;
  application_method: string;
  raw_text: string;
}

const REQUIRED_FIELD_KEYS: (keyof ParsedFields)[] = [
  "recruitment_field",
  "job_description",
  "qualifications",
  "preferences",
  "company_name",
  "industry",
  "deadline_raw",
  "required_documents",
  "application_method",
  "raw_text",
];

export function classifyParseResult(
  fields: ParsedFields,
  fetchFailed: boolean
): { status: "success" | "partial" | "fail"; failureReason?: string } {
  if (fetchFailed || !fields.raw_text.trim()) {
    return { status: "fail", failureReason: "parse_error" };
  }

  const missing = REQUIRED_FIELD_KEYS.filter((key) => {
    if (key === "deadline_raw") {
      return !fields.deadline_raw.trim() && !fields.deadline_date;
    }
    return !String(fields[key] ?? "").trim();
  });

  if (missing.length === 0) {
    return { status: "success" };
  }

  return { status: "partial", failureReason: "partial_fields" };
}

function textOrEmpty($: cheerio.CheerioAPI, selector: string): string {
  return $(selector).first().text().replace(/\s+/g, " ").trim();
}

function parseDeadline(raw: string): string | null {
  const match = raw.match(/(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// 상시/수시채용은 신호값 "상시채용"으로 남기고, 저장 직전에 status로 변환한다.
function normalizeDeadlineRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/상시|수시|채용\s*시|충원\s*시/.test(trimmed)) return "상시채용";
  return trimmed;
}

export async function parseSaramin(
  html: string,
  url: string
): Promise<ParsedFields> {
  const $ = cheerio.load(html);
  const company_name =
    textOrEmpty($, ".company_name, .corp_name, h1 a") ||
    textOrEmpty($, "[class*='company']");
  const job_title =
    textOrEmpty($, ".job_tit, .posting_title, h1") || textOrEmpty($, "title");
  const recruitment_field = job_title;
  const job_description = textOrEmpty($, ".job_desc, .wrap_jview, .user_content");
  const qualifications = textOrEmpty($, ".wrap_qualification, [class*='qualification']");
  const preferences = textOrEmpty($, ".wrap_preference, [class*='preference']");
  const industry = textOrEmpty($, ".company_info dd, .corp_info");
  const deadline_raw = normalizeDeadlineRaw(
    textOrEmpty($, ".date_end, .closing_date, [class*='deadline']")
  );
  const required_documents = textOrEmpty($, "[class*='document'], [class*='서류']");
  const application_method = textOrEmpty($, "[class*='apply'], [class*='지원']");
  const raw_text =
    $("body").text().replace(/\s+/g, " ").trim().slice(0, 50000) ||
    `${company_name} ${job_title} ${url}`;

  return {
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
    raw_text,
  };
}

export async function parseJobkorea(
  html: string,
  url: string
): Promise<ParsedFields> {
  const $ = cheerio.load(html);
  const company_name = textOrEmpty($, ".coName, .company-name, .tit_company");
  const job_title = textOrEmpty($, ".tit_job, .posting_title, h1");
  const recruitment_field = job_title;
  const job_description = textOrEmpty($, ".tbList, .recruit_job_info, .detailInfo");
  const qualifications = textOrEmpty($, "[class*='qualification'], .tbQual");
  const preferences = textOrEmpty($, "[class*='preference'], .tbPref");
  const industry = textOrEmpty($, ".coDesc, .company_info");
  const deadline_raw = normalizeDeadlineRaw(
    textOrEmpty($, ".date, .closing, [class*='deadline']")
  );
  const required_documents = textOrEmpty($, "[class*='document']");
  const application_method = textOrEmpty($, "[class*='apply']");
  const raw_text =
    $("body").text().replace(/\s+/g, " ").trim().slice(0, 50000) ||
    `${company_name} ${job_title} ${url}`;

  return {
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
    raw_text,
  };
}

export async function fetchAndParse(
  url: string,
  platform: "saramin" | "jobkorea",
  timeoutMs: number
): Promise<{
  fields: ParsedFields;
  fetchFailed: boolean;
  failureReason?: string;
}> {
  const debug = process.env.PARSE_DEBUG === "true";
  const httpTimeout = Math.min(timeoutMs, 10000);
  const resolvedUrl = await resolveRedirectUrl(url, httpTimeout);

  if (platform === "saramin") {
    const saraminResult = await parseSaraminFromAjax(resolvedUrl, httpTimeout, debug);
    if (saraminResult) {
      return saraminResult;
    }

    if (!extractSaraminRecIdx(resolvedUrl)) {
      return {
        fields: emptyFields(),
        fetchFailed: true,
        failureReason: "parse_error",
      };
    }
  }

  if (platform === "jobkorea") {
    const jobkoreaResult = await parseJobkoreaFromPage(resolvedUrl, httpTimeout, debug);
    if (jobkoreaResult) {
      return jobkoreaResult;
    }
  }

  const httpResult = await fetchHtml(resolvedUrl, httpTimeout);
  if (!httpResult.failureReason && httpResult.html) {
    const fields = await parsePlatformHtml(platform, httpResult.html, resolvedUrl);
    if (hasUsableContent(fields, platform)) {
      if (debug) {
        console.info(`[parse] http fetch ok textLen=${fields.raw_text.length}`);
      }
      return { fields, fetchFailed: false };
    }
    if (debug) {
      console.info("[parse] http fetch returned insufficient content");
    }
  } else if (debug) {
    console.info(`[parse] http fetch failed: ${httpResult.failureReason ?? "empty"}`);
  }

  if (process.env.PARSE_USE_PLAYWRIGHT === "true") {
    const playwrightTimeout = Math.min(timeoutMs, 15000);
    const page = await fetchRenderedPage(resolvedUrl, platform, playwrightTimeout);

    if (!page.failureReason) {
      const fields = await parsePlatformHtml(platform, page.html, resolvedUrl);
      if (page.text.trim()) {
        fields.raw_text = page.text;
      }
      if (hasUsableContent(fields, platform) || fields.raw_text.trim()) {
        return { fields, fetchFailed: false };
      }
    }

    if (httpResult.html) {
      const fields = await parsePlatformHtml(platform, httpResult.html, resolvedUrl);
      if (hasUsableContent(fields, platform) || fields.raw_text.trim()) {
        return { fields, fetchFailed: false };
      }
    }

    return {
      fields: emptyFields(),
      fetchFailed: true,
      failureReason: page.failureReason ?? httpResult.failureReason ?? "parse_error",
    };
  }

  if (httpResult.html) {
    const fields = await parsePlatformHtml(platform, httpResult.html, resolvedUrl);
    if (fields.raw_text.trim() || fields.job_title.trim() || fields.company_name.trim()) {
      return { fields, fetchFailed: false };
    }
  }

  return {
    fields: emptyFields(),
    fetchFailed: true,
    failureReason: httpResult.failureReason ?? "parse_error",
  };
}

async function parseSaraminFromAjax(
  url: string,
  httpTimeout: number,
  debug: boolean
): Promise<{ fields: ParsedFields; fetchFailed: boolean } | null> {
  const recIdx = extractSaraminRecIdx(url);
  if (!recIdx) {
    if (debug) console.info("[parse] saramin: rec_idx not found in URL");
    return null;
  }

  const detailHtml = await fetchSaraminDetailHtml(recIdx, url, httpTimeout);
  if (!detailHtml.trim()) {
    if (debug) console.info("[parse] saramin ajax empty response");
    return null;
  }

  // 상세요강(B 영역) iframe 본문을 별도로 가져온다.
  const detailBody = await fetchSaraminDetailBody(detailHtml, url, httpTimeout);
  if (debug) {
    console.info(
      `[parse] saramin detail body textLen=${detailBody.text.length} images=${detailBody.imageUrls.length}`
    );
  }

  const fields = parseSaraminDetail(detailHtml, url, detailBody);
  if (hasSaraminDetailContent(fields)) {
    if (debug) console.info("[parse] saramin ajax ok");
    return { fields, fetchFailed: false };
  }

  if (fields.job_title.trim() || fields.company_name.trim()) {
    if (debug) console.info("[parse] saramin ajax partial");
    return { fields, fetchFailed: false };
  }

  return null;
}

async function parseJobkoreaFromPage(
  url: string,
  httpTimeout: number,
  debug: boolean
): Promise<{ fields: ParsedFields; fetchFailed: boolean } | null> {
  const gno = extractJobkoreaGno(url);
  if (!gno) {
    if (debug) console.info("[parse] jobkorea: Gno not found in URL");
    return null;
  }

  const mainResult = await fetchHtml(url, httpTimeout);
  if (mainResult.failureReason || !mainResult.html.trim()) {
    if (debug) {
      console.info(
        `[parse] jobkorea main fetch failed: ${mainResult.failureReason ?? "empty"}`
      );
    }
    return null;
  }

  // 상세 공고 본문(B영역) iframe을 별도로 가져온다.
  const detailBody = await fetchJobkoreaDetailBody(gno, url, httpTimeout);
  if (debug) {
    console.info(
      `[parse] jobkorea detail body textLen=${detailBody.text.length} images=${detailBody.imageUrls.length}`
    );
  }

  const fields = parseJobkoreaDetail(mainResult.html, detailBody);
  if (hasJobkoreaDetailContent(fields)) {
    if (debug) console.info("[parse] jobkorea page ok");
    return { fields, fetchFailed: false };
  }

  if (fields.job_title.trim() || fields.company_name.trim()) {
    if (debug) console.info("[parse] jobkorea page partial");
    return { fields, fetchFailed: false };
  }

  return null;
}

async function resolveRedirectUrl(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });

    await response.body?.cancel().catch(() => undefined);
    return response.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

async function parsePlatformHtml(
  platform: "saramin" | "jobkorea",
  html: string,
  url: string
): Promise<ParsedFields> {
  return platform === "saramin"
    ? parseSaramin(html, url)
    : parseJobkorea(html, url);
}

function hasUsableContent(
  fields: ParsedFields,
  platform: "saramin" | "jobkorea"
): boolean {
  if (platform === "saramin") {
    return hasSaraminDetailContent(fields);
  }
  if (hasJobkoreaDetailContent(fields)) {
    return true;
  }
  return fields.raw_text.trim().length >= 200;
}

type FetchFailureReason = "not_found" | "login_required" | "timeout" | "parse_error";

async function fetchHtml(
  url: string,
  timeoutMs: number
): Promise<{ html: string; failureReason?: FetchFailureReason }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });

    if (response.status === 404) {
      return { html: "", failureReason: "not_found" };
    }

    if (response.status === 401 || response.status === 403) {
      return { html: "", failureReason: "login_required" };
    }

    if (!response.ok) {
      return { html: "", failureReason: "parse_error" };
    }

    const html = await response.text();
    return { html };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"));
    return { html: "", failureReason: isTimeout ? "timeout" : "parse_error" };
  } finally {
    clearTimeout(timer);
  }
}

function emptyFields(): ParsedFields {
  return {
    company_name: "",
    job_title: "",
    recruitment_field: "",
    job_description: "",
    qualifications: "",
    preferences: "",
    industry: "",
    deadline_raw: "",
    deadline_date: null,
    required_documents: "",
    application_method: "",
    raw_text: "",
  };
}
