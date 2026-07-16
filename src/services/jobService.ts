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
import {
  createKeywordExtractor,
  normalizeKeywords,
  normalizeStructuredKeywordsFromUnknown,
} from "./llm/KeywordExtractor.js";
import {
  createFieldExtractor,
  mergeLlmFields,
} from "./llm/FieldExtractor.js";
import { fetchAndParse, classifyParseResult } from "./parser/index.js";
import { validateJobUrl } from "./parser/urlValidator.js";
import { logEvent } from "./analyticsService.js";
import { resolveJobImage, resolveJobImages, resolveJobsImages } from "./jobImageUrl.js";
import { validateFolderId } from "./folderService.js";
import { resolveDeadlineFields } from "../lib/deadlineStatus.js";
import {
  keywordTexts,
  normalizeStructuredKeywords,
  parseStructuredKeywords,
  type StructuredKeyword,
} from "../lib/keywords.js";

export type SortOption =
  | "company_asc"
  | "company_desc"
  | "saved_at_asc"
  | "saved_at_desc"
  | "deadline_asc"
  | "deadline_desc";

export type DeadlineStatus = "always_open" | "closed" | null;

export interface JobPostingRow {
  id: string;
  user_id: string;
  source_url: string;
  platform: string;
  parsing_status: string;
  parse_failure_reason: string | null;
  folder_id: string | null;
  company_name: string;
  job_title: string;
  recruitment_field: string;
  job_description: string;
  qualifications: string;
  preferences: string;
  industry: string;
  deadline_raw: string;
  deadline_date: string | null;
  deadline_status: DeadlineStatus;
  required_documents: string;
  application_method: string;
  raw_text: string;
  memo: string;
  competency_keywords: StructuredKeyword[];
  saved_at: string;
  updated_at: string;
  job_posting_images?: { id: string; storage_path: string; sort_order: number }[];
}

function companySortKey(name: string): string {
  const first = name.trim().charAt(0) || " ";
  if (/\s/.test(first)) return `0${name}`;
  if (/[^a-zA-Z0-9가-힣\s]/.test(first)) return `1${name}`;
  if (/\d/.test(first)) return `2${name}`;
  if (/[가-힣]/.test(first)) return `3${name}`;
  return `4${name}`;
}

function isExpired(job: Pick<JobPostingRow, "deadline_date" | "deadline_status">): boolean {
  if (job.deadline_status === "closed") return true;
  if (job.deadline_status === "always_open") return false;
  if (!job.deadline_date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(job.deadline_date);
  return deadline < today;
}

function normalizeJobRow(row: Record<string, unknown>): JobPostingRow {
  return {
    ...(row as unknown as JobPostingRow),
    competency_keywords: parseStructuredKeywords(row.competency_keywords),
    deadline_status: (row.deadline_status as DeadlineStatus) ?? null,
    folder_id: (row.folder_id as string | null) ?? null,
  };
}

export function sortJobs(
  jobs: JobPostingRow[],
  sort: SortOption
): JobPostingRow[] {
  const copy = [...jobs];

  if (sort.startsWith("deadline")) {
    const active = copy.filter((j) => !isExpired(j));
    const expired = copy.filter((j) => isExpired(j));

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

export async function parseAndCreateJob(
  userId: string,
  urlInput: string,
  folderId?: string | null
) {
  const validation = validateJobUrl(urlInput);
  if (!validation.valid) {
    throw new AppError(400, validation.message, validation.code);
  }

  const resolvedFolderId = await validateFolderId(userId, folderId);

  await logEvent(userId, "url_submitted", {
    url: validation.normalizedUrl,
    folder_id: resolvedFolderId,
  });

  const timeoutMs = Number(process.env.PARSE_TIMEOUT_MS ?? 30000);
  const { fields: parsedFields, fetchFailed, failureReason } = await fetchAndParse(
    validation.normalizedUrl,
    validation.platform,
    timeoutMs
  );

  let fields = parsedFields;
  let classification = classifyParseResult(fields, fetchFailed);

  if (!fetchFailed && fields.raw_text.trim()) {
    const fieldExtractor = createFieldExtractor();
    const extracted = await fieldExtractor.extract(fields.raw_text);
    if (extracted) {
      fields = mergeLlmFields(fields, extracted);
      classification = classifyParseResult(fields, false);
    }
  }

  fields = { ...fields, recruitment_field: fields.job_title };

  const deadlineFields = resolveDeadlineFields(
    fields.deadline_raw,
    fields.deadline_date
  );
  fields = {
    ...fields,
    deadline_raw: deadlineFields.deadline_raw,
    deadline_date: deadlineFields.deadline_date,
  };

  const extractor = createKeywordExtractor();

  let keywords: StructuredKeyword[] = [];
  if (classification.status !== "fail") {
    keywords = await extractor.extract({
      qualifications: fields.qualifications,
      preferences: fields.preferences,
    });
    keywords = normalizeStructuredKeywords(keywords);
  }

  if (!isSupabaseConfigured()) {
    const job = devCreateJob(userId, {
      source_url: validation.normalizedUrl,
      platform: validation.platform,
      parsing_status: classification.status,
      parse_failure_reason:
        failureReason ?? classification.failureReason ?? null,
      folder_id: resolvedFolderId,
      company_name: fields.company_name,
      job_title: fields.job_title,
      recruitment_field: fields.recruitment_field,
      job_description: fields.job_description,
      qualifications: fields.qualifications,
      preferences: fields.preferences,
      industry: fields.industry,
      deadline_raw: fields.deadline_raw,
      deadline_date: fields.deadline_date,
      deadline_status: deadlineFields.deadline_status,
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
      folder_id: resolvedFolderId,
      company_name: fields.company_name,
      job_title: fields.job_title,
      recruitment_field: fields.recruitment_field,
      job_description: fields.job_description,
      qualifications: fields.qualifications,
      preferences: fields.preferences,
      industry: fields.industry,
      deadline_raw: fields.deadline_raw,
      deadline_date: fields.deadline_date,
      deadline_status: deadlineFields.deadline_status,
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
    folder_id: resolvedFolderId,
  });

  return { job: normalizeJobRow(data), parseResult: classification.status };
}

export async function listJobs(
  userId: string,
  options: {
    folderId?: string;
    uncategorized?: boolean;
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

  if (options.uncategorized) {
    query = query.is("folder_id", null);
  } else if (options.folderId) {
    query = query.eq("folder_id", options.folderId);
  }

  const { data, error } = await query;
  if (error) throw new AppError(500, error.message);

  let jobs = (data ?? []).map((row) => normalizeJobRow(row));

  if (options.excludeExpired) {
    jobs = jobs.filter((j) => !isExpired(j));
  }

  if (options.keywords?.length) {
    jobs = jobs.filter((j) => {
      const kw = keywordTexts(j.competency_keywords);
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
  return resolveJobImages(normalizeJobRow(data));
}

function normalizeKeywordPayload(
  value: unknown
): StructuredKeyword[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return normalizeKeywords(value as string[]);
  }
  return normalizeStructuredKeywords(parseStructuredKeywords(value));
}

export async function updateJob(
  userId: string,
  jobId: string,
  payload: Partial<JobPostingRow> & { competency_keywords?: unknown }
) {
  if (payload.folder_id !== undefined) {
    await validateFolderId(userId, payload.folder_id);
  }

  const allowed: Record<string, unknown> = {
    folder_id: payload.folder_id,
    company_name: payload.company_name,
    job_title: payload.job_title,
    recruitment_field: payload.recruitment_field,
    job_description: payload.job_description,
    qualifications: payload.qualifications,
    preferences: payload.preferences,
    industry: payload.industry,
    deadline_raw: payload.deadline_raw,
    deadline_date: payload.deadline_date,
    deadline_status: payload.deadline_status,
    required_documents: payload.required_documents,
    application_method: payload.application_method,
    raw_text: payload.raw_text,
    memo: payload.memo,
    competency_keywords: normalizeKeywordPayload(payload.competency_keywords),
  };

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

  if (payload.folder_id) {
    await logEvent(userId, "folder_assigned", {
      job_id: jobId,
      folder_id: payload.folder_id,
    });
  }

  await logEvent(userId, "save_success", { job_id: jobId });
  return normalizeJobRow(data);
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
    for (const kw of keywordTexts(row.competency_keywords)) {
      set.add(kw);
    }
  }

  return [...set].sort((a, b) => a.localeCompare(b, "ko"));
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

export { normalizeStructuredKeywordsFromUnknown };
