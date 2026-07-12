import { supabaseAdmin, isSupabaseConfigured } from "../db/supabase.js";
import {
  devAddJobImage,
  devCreateJob,
  devDeleteJob,
  devDeleteJobImage,
  devGetAllKeywords,
  devGetJob,
  devListJobs,
  devUpdateJob,
} from "../db/devStore.js";
import { AppError } from "../middleware/errorHandler.js";
import { createKeywordExtractor, normalizeKeywords } from "./llm/KeywordExtractor.js";
import {
  createFieldExtractor,
  mergeLlmFields,
} from "./llm/FieldExtractor.js";
import { fetchAndParse, classifyParseResult } from "./parser/index.js";
import { validateJobUrl } from "./parser/urlValidator.js";
import { logEvent } from "./analyticsService.js";
import { resolveJobImage, resolveJobImages, resolveJobsImages } from "./jobImageUrl.js";

export type SortOption =
  | "company_asc"
  | "company_desc"
  | "saved_at_asc"
  | "saved_at_desc"
  | "deadline_asc"
  | "deadline_desc";

const PURPOSE_TAGS = ["지원예정", "직무분석", "관심기업", "기타"] as const;
export type PurposeTag = (typeof PURPOSE_TAGS)[number];

export interface JobPostingRow {
  id: string;
  user_id: string;
  source_url: string;
  platform: string;
  parsing_status: string;
  parse_failure_reason: string | null;
  purpose_tag: string | null;
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
  memo: string;
  competency_keywords: string[];
  saved_at: string;
  updated_at: string;
  job_posting_images?: { id: string; storage_path: string; sort_order: number }[];
}

function parseKeywordArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0
        );
      }
    } catch {
      return value.trim() ? [value.trim()] : [];
    }
  }
  return [];
}

function companySortKey(name: string): string {
  const first = name.trim().charAt(0) || " ";
  if (/\s/.test(first)) return `0${name}`;
  if (/[^a-zA-Z0-9가-힣\s]/.test(first)) return `1${name}`;
  if (/\d/.test(first)) return `2${name}`;
  if (/[가-힣]/.test(first)) return `3${name}`;
  return `4${name}`;
}

function isExpired(deadlineDate: string | null): boolean {
  if (!deadlineDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(deadlineDate);
  return deadline < today;
}

export function sortJobs(
  jobs: JobPostingRow[],
  sort: SortOption
): JobPostingRow[] {
  const copy = [...jobs];

  if (sort.startsWith("deadline")) {
    const active = copy.filter((j) => !isExpired(j.deadline_date));
    const expired = copy.filter((j) => isExpired(j.deadline_date));

    const sortFn = (a: JobPostingRow, b: JobPostingRow) => {
      const da = a.deadline_date ?? "9999-12-31";
      const db = b.deadline_date ?? "9999-12-31";
      return sort === "deadline_asc"
        ? da.localeCompare(db)
        : db.localeCompare(da);
    };

    active.sort(sortFn);
    expired.sort(sortFn);
    return [...active, ...expired];
  }

  copy.sort((a, b) => {
    switch (sort) {
      case "company_asc":
        return companySortKey(a.company_name).localeCompare(
          companySortKey(b.company_name),
          "ko"
        );
      case "company_desc":
        return companySortKey(b.company_name).localeCompare(
          companySortKey(a.company_name),
          "ko"
        );
      case "saved_at_asc":
        return a.saved_at.localeCompare(b.saved_at);
      case "saved_at_desc":
      default:
        return b.saved_at.localeCompare(a.saved_at);
    }
  });

  return copy;
}

export async function parseAndCreateJob(userId: string, urlInput: string) {
  const validation = validateJobUrl(urlInput);
  if (!validation.valid) {
    throw new AppError(400, validation.message, validation.code);
  }

  await logEvent(userId, "url_submitted", { url: validation.normalizedUrl });

  const timeoutMs = Number(process.env.PARSE_TIMEOUT_MS ?? 30000);
  const { fields: parsedFields, fetchFailed, failureReason } = await fetchAndParse(
    validation.normalizedUrl,
    validation.platform,
    timeoutMs
  );

  let fields = parsedFields;
  let classification = classifyParseResult(fields, fetchFailed);

  // 원문(B)이 있으면 LLM이 각 필드에 맞게 내용을 분류해 채운다.
  if (!fetchFailed && fields.raw_text.trim()) {
    const fieldExtractor = createFieldExtractor();
    const extracted = await fieldExtractor.extract(fields.raw_text);
    if (extracted) {
      fields = mergeLlmFields(fields, extracted);
      classification = classifyParseResult(fields, false);
    }
  }

  // 모집 분야는 파싱된 직무명과 항상 동일하게 저장한다. (JD-DP-INS-01 / JD-DP-03)
  fields = { ...fields, recruitment_field: fields.job_title };

  const extractor = createKeywordExtractor();

  let keywords: string[] = [];
  if (classification.status !== "fail") {
    keywords = await extractor.extract({
      qualifications: fields.qualifications,
      preferences: fields.preferences,
    });
    keywords = normalizeKeywords(keywords);
  }

  if (!isSupabaseConfigured()) {
    const job = devCreateJob(userId, {
      source_url: validation.normalizedUrl,
      platform: validation.platform,
      parsing_status: classification.status,
      parse_failure_reason:
        failureReason ?? classification.failureReason ?? null,
      purpose_tag: null,
      company_name: fields.company_name,
      job_title: fields.job_title,
      recruitment_field: fields.recruitment_field,
      job_description: fields.job_description,
      qualifications: fields.qualifications,
      preferences: fields.preferences,
      industry: fields.industry,
      deadline_raw: fields.deadline_raw,
      deadline_date: fields.deadline_date,
      required_documents: fields.required_documents,
      application_method: fields.application_method,
      raw_text: fields.raw_text,
      memo: "",
      competency_keywords: keywords,
    });
    return { job, parseResult: classification.status };
  }

  const { data, error } = await supabaseAdmin
    .from("job_postings")
    .insert({
      user_id: userId,
      source_url: validation.normalizedUrl,
      platform: validation.platform,
      parsing_status: classification.status,
      parse_failure_reason: failureReason ?? classification.failureReason ?? null,
      company_name: fields.company_name,
      job_title: fields.job_title,
      recruitment_field: fields.recruitment_field,
      job_description: fields.job_description,
      qualifications: fields.qualifications,
      preferences: fields.preferences,
      industry: fields.industry,
      deadline_raw: fields.deadline_raw,
      deadline_date: fields.deadline_date,
      required_documents: fields.required_documents,
      application_method: fields.application_method,
      raw_text: fields.raw_text,
      competency_keywords: keywords,
    })
    .select()
    .single();

  if (error) {
    throw new AppError(500, "공고 저장에 실패했습니다.", "save_failed");
  }

  await logEvent(userId, "parse_result", {
    result: classification.status,
    platform: validation.platform,
    job_id: data.id,
  });

  return { job: data as JobPostingRow, parseResult: classification.status };
}

export async function listJobs(
  userId: string,
  options: {
    tag?: string;
    keywords?: string[];
    excludeExpired?: boolean;
    sort?: SortOption;
  }
) {
  if (!isSupabaseConfigured()) {
    const jobs = devListJobs(userId, options);
    return resolveJobsImages(sortJobs(jobs, options.sort ?? "saved_at_desc"));
  }

  let query = supabaseAdmin
    .from("job_postings")
    .select("*, job_posting_images(id, storage_path, sort_order)")
    .eq("user_id", userId);

  if (options.tag && PURPOSE_TAGS.includes(options.tag as PurposeTag)) {
    query = query.eq("purpose_tag", options.tag);
  }

  const { data, error } = await query;
  if (error) throw new AppError(500, error.message);

  let jobs = (data ?? []) as JobPostingRow[];

  if (options.excludeExpired) {
    jobs = jobs.filter((j) => !isExpired(j.deadline_date));
  }

  if (options.keywords?.length) {
    jobs = jobs.filter((j) => {
      const kw = parseKeywordArray(j.competency_keywords);
      return options.keywords!.some((k) => kw.includes(k));
    });
  }

  jobs = sortJobs(jobs, options.sort ?? "saved_at_desc");
  return resolveJobsImages(jobs);
}

export async function getJob(userId: string, jobId: string) {
  if (!isSupabaseConfigured()) {
    const job = devGetJob(userId, jobId);
    if (!job) throw new AppError(404, "공고를 찾을 수 없습니다.");
    return resolveJobImages(job);
  }

  const { data, error } = await supabaseAdmin
    .from("job_postings")
    .select("*, job_posting_images(id, storage_path, sort_order)")
    .eq("user_id", userId)
    .eq("id", jobId)
    .single();

  if (error || !data) throw new AppError(404, "공고를 찾을 수 없습니다.");
  return resolveJobImages(data as JobPostingRow);
}

export async function updateJob(
  userId: string,
  jobId: string,
  payload: Partial<JobPostingRow>
) {
  const allowed: Partial<JobPostingRow> = {
    purpose_tag: payload.purpose_tag,
    company_name: payload.company_name,
    job_title: payload.job_title,
    recruitment_field: payload.recruitment_field,
    job_description: payload.job_description,
    qualifications: payload.qualifications,
    preferences: payload.preferences,
    industry: payload.industry,
    deadline_raw: payload.deadline_raw,
    deadline_date: payload.deadline_date,
    required_documents: payload.required_documents,
    application_method: payload.application_method,
    raw_text: payload.raw_text,
    memo: payload.memo,
    competency_keywords: payload.competency_keywords
      ? normalizeKeywords(payload.competency_keywords)
      : undefined,
  };

  // 직무명과 모집 분야는 항상 동일하게 유지한다. 사용자가 모집 분야를 수정하면
  // 직무명도 함께 동기화되고, 그 반대도 동일하게 동작한다. (JD-DP-INS-01 / JD-DP-03)
  if (payload.recruitment_field !== undefined || payload.job_title !== undefined) {
    const synced = payload.recruitment_field ?? payload.job_title;
    allowed.recruitment_field = synced;
    allowed.job_title = synced;
  }

  const clean = Object.fromEntries(
    Object.entries(allowed).filter(([, v]) => v !== undefined)
  );

  if (!isSupabaseConfigured()) {
    const updated = devUpdateJob(userId, jobId, clean as Partial<JobPostingRow>);
    if (!updated) throw new AppError(404, "공고를 찾을 수 없습니다.");
    return updated;
  }

  const { data, error } = await supabaseAdmin
    .from("job_postings")
    .update(clean)
    .eq("user_id", userId)
    .eq("id", jobId)
    .select()
    .single();

  if (error) throw new AppError(500, error.message);

  if (payload.purpose_tag) {
    await logEvent(userId, "tag_assigned", {
      job_id: jobId,
      tag: payload.purpose_tag,
    });
  }

  await logEvent(userId, "save_success", { job_id: jobId });
  return data as JobPostingRow;
}

export async function deleteJob(userId: string, jobId: string) {
  if (!isSupabaseConfigured()) {
    if (!devDeleteJob(userId, jobId)) {
      throw new AppError(404, "공고를 찾을 수 없습니다.");
    }
    return;
  }

  const { error } = await supabaseAdmin
    .from("job_postings")
    .delete()
    .eq("user_id", userId)
    .eq("id", jobId);

  if (error) throw new AppError(500, error.message);
}

export async function getAllKeywords(userId: string): Promise<string[]> {
  if (!isSupabaseConfigured()) {
    return devGetAllKeywords(userId);
  }

  const { data } = await supabaseAdmin
    .from("job_postings")
    .select("competency_keywords")
    .eq("user_id", userId);

  const set = new Set<string>();
  for (const row of data ?? []) {
    for (const kw of parseKeywordArray(row.competency_keywords)) {
      set.add(kw);
    }
  }

  const keywords = [...set].sort((a, b) => a.localeCompare(b, "ko"));

  return keywords;
}

export async function addJobImage(
  userId: string,
  jobId: string,
  storagePath: string,
  sortOrder: number
) {
  if (!isSupabaseConfigured()) {
    const image = devAddJobImage(userId, jobId, storagePath, sortOrder);
    if (!image) {
      throw new AppError(400, "이미지는 최대 5개까지 첨부할 수 있어요.", "max_images");
    }
    return resolveJobImage(image);
  }

  const { count } = await supabaseAdmin
    .from("job_posting_images")
    .select("*", { count: "exact", head: true })
    .eq("job_posting_id", jobId);

  if ((count ?? 0) >= 5) {
    throw new AppError(400, "이미지는 최대 5개까지 첨부할 수 있어요.", "max_images");
  }

  const { data, error } = await supabaseAdmin
    .from("job_posting_images")
    .insert({
      job_posting_id: jobId,
      user_id: userId,
      storage_path: storagePath,
      sort_order: sortOrder,
    })
    .select()
    .single();

  if (error) throw new AppError(500, error.message);
  return resolveJobImage(data);
}

export async function deleteJobImage(
  userId: string,
  jobId: string,
  imageId: string
) {
  if (!isSupabaseConfigured()) {
    if (!devDeleteJobImage(userId, jobId, imageId)) {
      throw new AppError(404, "이미지를 찾을 수 없습니다.");
    }
    return;
  }

  const { error } = await supabaseAdmin
    .from("job_posting_images")
    .delete()
    .eq("user_id", userId)
    .eq("job_posting_id", jobId)
    .eq("id", imageId);

  if (error) throw new AppError(500, error.message);
}

export { PURPOSE_TAGS };
