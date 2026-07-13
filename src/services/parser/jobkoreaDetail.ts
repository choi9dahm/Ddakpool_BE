import * as cheerio from "cheerio";
import type { ParsedFields } from "./index.js";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
};

const JOBKOREA_ORIGIN = "https://www.jobkorea.co.kr";

// 잡코리아 상세 본문(B영역) 컨테이너 우선순위. 첫 매칭 요소를 본문 범위로 사용.
const DETAIL_BODY_SELECTORS = [
  ".tempate-detailed-summary-root",
  ".detailTable",
  ".html-viewer-content-reset",
  ".content_sec",
];

export interface JobkoreaDetailBody {
  text: string;
  imageUrls: string[];
}

interface JobkoreaMeta {
  company_name: string;
  job_title: string;
  deadline_raw: string;
  deadline_date: string | null;
  location: string;
  employment_type: string;
  experience: string;
  education: string;
}

/** GI_Read/{id} 경로 또는 Gno 쿼리에서 공고 id를 추출한다. */
export function extractJobkoreaGno(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const fromQuery =
      parsed.searchParams.get("Gno") ?? parsed.searchParams.get("gno");
    if (fromQuery && /^\d{4,}$/.test(fromQuery)) return fromQuery;

    const pathMatch = parsed.pathname.match(/GI_Read(?:_[A-Za-z]+)*\/(\d{4,})/i);
    if (pathMatch) return pathMatch[1];

    const anyDigits = parsed.pathname.match(/\/(\d{5,})(?:\/|$)/);
    if (anyDigits) return anyDigits[1];

    return null;
  } catch {
    return null;
  }
}

function parseDeadline(raw: string): string | null {
  const match = raw.match(/(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// 상시/수시채용처럼 마감일이 없는 공고는 마감일 필드를 공란으로 둔다. (JD-DP-INS-08)
function isRecurringDeadline(raw: string): boolean {
  return /상시|수시|채용\s*시|충원\s*시|채용시\s*마감/.test(raw);
}

function normalizeDeadlineRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || isRecurringDeadline(trimmed)) return "";
  return trimmed;
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = firstString(item);
      if (s) return s;
    }
  }
  return "";
}

function findJobPosting(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const typeStr = Array.isArray(type) ? type.join(",") : String(type ?? "");
  if (typeStr.includes("JobPosting")) return obj;

  if (obj["@graph"]) return findJobPosting(obj["@graph"]);
  return null;
}

/** 메인 GI_Read 페이지의 schema.org JobPosting JSON-LD에서 메타데이터를 추출한다. */
export function parseJobkoreaJsonLd(html: string): JobkoreaMeta {
  const $ = cheerio.load(html);
  let posting: Record<string, unknown> | null = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (posting) return;
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      posting = findJobPosting(JSON.parse(raw));
    } catch {
      /* JSON 파싱 실패 시 무시 */
    }
  });

  const empty: JobkoreaMeta = {
    company_name: "",
    job_title: "",
    deadline_raw: "",
    deadline_date: null,
    location: "",
    employment_type: "",
    experience: "",
    education: "",
  };
  if (!posting) return empty;

  const p = posting as Record<string, unknown>;
  const job_title = firstString(p.title);

  const org = p.hiringOrganization as Record<string, unknown> | undefined;
  const company_name = org ? firstString(org.name) : "";

  const validThrough = firstString(p.validThrough);
  const deadline_date = parseDeadline(validThrough);
  const deadline_raw = normalizeDeadlineRaw(
    deadline_date ? deadline_date.replace(/-/g, ".") : validThrough
  );

  let location = "";
  const jobLocation = p.jobLocation as Record<string, unknown> | undefined;
  const address = jobLocation?.address as Record<string, unknown> | undefined;
  if (address) location = firstString(address.streetAddress);

  return {
    company_name,
    job_title,
    deadline_raw,
    deadline_date,
    location,
    employment_type: firstString(p.employmentType),
    experience: firstString(p.experienceRequirements),
    education: firstString(p.educationRequirements),
  };
}

function resolveImageUrl(src: string): string {
  if (src.startsWith("http")) return src;
  if (src.startsWith("//")) return `https:${src}`;
  if (src.startsWith("/")) return `${JOBKOREA_ORIGIN}${src}`;
  return src;
}

/** 상세 본문 HTML에서 텍스트와 이미지(이미지형 JD)를 추출한다. */
function extractDetailBody(html: string): JobkoreaDetailBody {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  let scopeSelector = "body";
  for (const selector of DETAIL_BODY_SELECTORS) {
    const el = $(selector).first();
    if (el.length && el.text().replace(/\s+/g, "").length > 0) {
      scopeSelector = selector;
      break;
    }
  }
  const scope = $(scopeSelector).first();

  const imageUrls: string[] = [];
  scope.find("img").each((_, el) => {
    const raw = $(el).attr("src") || $(el).attr("data-src") || "";
    if (!raw) return;
    const src = resolveImageUrl(raw);
    if (/^https?:/.test(src) && !imageUrls.includes(src)) {
      imageUrls.push(src);
    }
  });

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
 * 상세 공고 본문(B영역)은 GI_Read_Comt_Ifrm iframe에 별도로 렌더링된다.
 * 이 iframe을 직접 fetch해 본문 텍스트/이미지를 가져온다.
 */
export async function fetchJobkoreaDetailBody(
  gno: string,
  refererUrl: string,
  timeoutMs = 10000
): Promise<JobkoreaDetailBody> {
  const iframeUrl =
    `${JOBKOREA_ORIGIN}/Recruit/GI_Read_Comt_Ifrm?Oem_Code=C1` +
    `&Gno=${encodeURIComponent(gno)}&isHiringCenter=false&hideMapView=false`;

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
    return extractDetailBody(await response.text());
  } catch {
    return { text: "", imageUrls: [] };
  } finally {
    clearTimeout(timer);
  }
}

function buildJobkoreaRawText(
  meta: JobkoreaMeta,
  detailBody: JobkoreaDetailBody
): string {
  const sections: string[] = [];

  if (meta.company_name) sections.push(`[기업명] ${meta.company_name}`);
  if (meta.job_title) sections.push(`[채용공고] ${meta.job_title}`);

  const core: string[] = [];
  if (meta.employment_type) core.push(`고용형태: ${meta.employment_type}`);
  if (meta.experience) core.push(`경력: ${meta.experience}`);
  if (meta.education) core.push(`학력: ${meta.education}`);
  if (meta.location) core.push(`근무지: ${meta.location}`);
  if (meta.deadline_raw) core.push(`마감일: ${meta.deadline_raw}`);
  if (core.length > 0) sections.push(`[핵심 정보]\n${core.join("\n")}`);

  const detailText = detailBody.text?.trim() ?? "";
  const detailImages = detailBody.imageUrls ?? [];
  if (detailText) {
    sections.push(`[상세요강]\n${detailText}`);
  }
  if (detailImages.length > 0) {
    sections.push(`[상세요강 이미지]\n${detailImages.join("\n")}`);
  }

  const composed = sections.join("\n\n").trim();
  if (composed) return composed.slice(0, 50000);

  return `${meta.company_name} ${meta.job_title}`.trim();
}

export function parseJobkoreaDetail(
  mainHtml: string,
  detailBody: JobkoreaDetailBody
): ParsedFields {
  const meta = parseJobkoreaJsonLd(mainHtml);

  // 담당업무/자격요건/우대사항은 LLM이 raw_text(상세요강)에서 분류해 채운다.
  const baseFields = {
    company_name: meta.company_name,
    job_title: meta.job_title,
    recruitment_field: meta.job_title,
    job_description: "",
    qualifications: "",
    preferences: "",
    industry: "",
    deadline_raw: meta.deadline_raw,
    deadline_date: meta.deadline_date,
    required_documents: "",
    application_method: "",
  };

  const raw_text = buildJobkoreaRawText(meta, detailBody);

  return {
    ...baseFields,
    raw_text,
  };
}

export function hasJobkoreaDetailContent(fields: ParsedFields): boolean {
  return Boolean(
    fields.company_name.trim() &&
      fields.job_title.trim() &&
      fields.raw_text.includes("[상세요강]")
  );
}
