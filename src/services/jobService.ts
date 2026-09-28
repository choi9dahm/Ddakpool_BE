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
  resolveIsImageBased,
  type ExtractedJobFields,
} from "./llm/FieldExtractor.js";
import { fetchAndParse, classifyParseResult, emptyFields } from "./parser/index.js";
import { recognizeRemoteImages } from "./ocrService.js";
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
  source_url: string | null;
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
  is_image_based: boolean;
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
    is_image_based: Boolean(row.is_image_based),
  };
}

function deadlineRank(
  job: JobPostingRow,
  sort: "deadline_asc" | "deadline_desc"
): number {
  // Expired jobs are handled separately; ranks apply to active jobs only.
  // asc: d-day imminent (earlier date) first, then always_open last among active
  // desc: always_open first, then later dates
  const isAlways = job.deadline_status === "always_open";
  if (sort === "deadline_asc") {
    if (isAlways) return Number.MAX_SAFE_INTEGER - 1;
    if (!job.deadline_date) return Number.MAX_SAFE_INTEGER - 2;
    return new Date(job.deadline_date).getTime();
  }
  // deadline_desc
  if (isAlways) return Number.MIN_SAFE_INTEGER;
  if (!job.deadline_date) return Number.MIN_SAFE_INTEGER + 1;
  return -new Date(job.deadline_date).getTime();
}

export function sortJobs(
  jobs: JobPostingRow[],
  sort: SortOption
): JobPostingRow[] {
  const copy = [...jobs];

  if (sort === "deadline_asc" || sort === "deadline_desc") {
    const active = copy.filter((j) => !isExpired(j));
    const expired = copy.filter((j) => isExpired(j));

    const sortFn = (a: JobPostingRow, b: JobPostingRow) => {
      const ra = deadlineRank(a, sort);
      const rb = deadlineRank(b, sort);
      if (ra !== rb) return ra - rb;
      return a.saved_at.localeCompare(b.saved_at);
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

async function assertUniqueSourceUrl(userId: string, sourceUrl: string) {
  if (!isSupabaseConfigured()) {
    const existing = devListJobs(userId, {}).find(
      (j) => j.source_url === sourceUrl
    );
    if (existing) {
      throw new AppError(
        409,
        "이미 저장된 공고입니다.",
        "duplicate_url"
      );
    }
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("job_postings")
    .select("id")
    .eq("user_id", userId)
    .eq("source_url", sourceUrl)
    .maybeSingle();

  if (error) {
    throw new AppError(500, "공고 조회에 실패했습니다.", "lookup_failed");
  }

  if (data) {
    throw new AppError(
      409,
      "이미 저장된 공고입니다.",
      "duplicate_url"
    );
  }
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

  await assertUniqueSourceUrl(userId, validation.normalizedUrl);

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

  // 원격 이미지 자동 OCR: 상세요강이 이미지로만 제공된 공고의 raw_text를 보강한다.
  // classify/LLM 추출보다 먼저 실행해 OCR 텍스트가 이후 파이프라인에 전부 반영되게 한다.
  const ocrAttempted = !fetchFailed && (fields.detail_image_urls?.length ?? 0) > 0;
  let ocrText = "";
  if (ocrAttempted) {
    ocrText = await recognizeRemoteImages(
      fields.detail_image_urls!,
      Number(process.env.OCR_TIMEOUT_MS ?? 8000),
      validation.normalizedUrl
    );
    if (ocrText.trim()) {
      fields = {
        ...fields,
        raw_text: `${fields.raw_text}\n\n[상세요강 이미지 OCR]\n${ocrText.trim()}`,
      };
    }
  }

  let classification = classifyParseResult(fields, fetchFailed);
  let isImageBased = detectImageBasedFromFields(fields);

  if (!fetchFailed && fields.raw_text.trim()) {
    const fieldExtractor = createFieldExtractor();
    const extracted = await fieldExtractor.extract(fields.raw_text);
    if (extracted) {
      fields = mergeLlmFields(fields, extracted);
      classification = classifyParseResult(fields, false);
      isImageBased = resolveIsImageBased(fields.raw_text, extracted);
    } else {
      isImageBased = resolveIsImageBased(fields.raw_text, null);
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
  if (
    classification.status !== "fail" &&
    (fields.qualifications.trim() || fields.preferences.trim())
  ) {
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
      is_image_based: isImageBased,
    });
    return {
      job,
      parseResult: classification.status,
      is_image_based: isImageBased,
    };
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
      is_image_based: isImageBased,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError(
        409,
        "이미 저장된 공고입니다.",
        "duplicate_url"
      );
    }
    throw new AppError(500, "공고 저장에 실패했습니다.", "save_failed");
  }

  await logEvent(userId, "parse_result", {
    result: classification.status,
    platform: validation.platform,
    job_id: data.id,
    folder_id: resolvedFolderId,
    is_image_based: isImageBased,
    ocr_attempted: ocrAttempted,
    ocr_filled_field: Boolean(
      ocrAttempted &&
        ocrText.trim() &&
        (fields.qualifications.trim() ||
          fields.preferences.trim() ||
          fields.job_description.trim())
    ),
  });

  return {
    job: normalizeJobRow(data),
    parseResult: classification.status,
    is_image_based: isImageBased,
  };
}

function detectImageBasedFromFields(fields: {
  raw_text: string;
}): boolean {
  return resolveIsImageBased(fields.raw_text, null);
}

/**
 * 수동 추가: 사용자가 붙여넣은 JD 원문을 파싱만 하고 DB에는 쓰지 않는다.
 * URL 경로(parseAndCreateJob)와 통합 헬퍼로 묶지 않는다 — 마감일 처리(LLM 값을 그대로
 * 채택)와 is_image_based(항상 false) 정책이 URL 경로와 반대라, 공유 함수로 묶으면
 * boolean 플래그로 분기하는 함수가 되어 오히려 기존 파싱 경로의 리스크만 커진다.
 */
/** parseRawText의 순수 변환부. 네트워크 없이 단위 테스트하기 위해 분리. */
export function buildManualDraft(
  rawText: string,
  extracted: ExtractedJobFields | null,
  keywords: StructuredKeyword[]
) {
  const fields = extracted
    ? { ...emptyFields(), ...extracted, raw_text: rawText }
    : { ...emptyFields(), raw_text: rawText };
  fields.recruitment_field = fields.job_title;

  // URL 경로(mergeLlmFields)와 달리 여기선 LLM 마감일을 그대로 채택한다.
  // 대체할 파서(dt/dd) 값이 없기 때문.
  const deadlineFields = resolveDeadlineFields(fields.deadline_raw, fields.deadline_date);
  const classification = classifyParseResult(fields, false);

  return {
    ...fields,
    ...deadlineFields,
    competency_keywords: normalizeStructuredKeywords(keywords),
    parsing_status: classification.status,
    parse_failure_reason: null as string | null,
    is_image_based: false,
    platform: "manual",
    source_url: null as string | null,
  };
}

export async function parseRawText(rawText: string) {
  const extracted = await createFieldExtractor().extract(rawText);
  const fields = extracted ?? null;
  const keywords = await createKeywordExtractor().extract({
    qualifications: fields?.qualifications ?? "",
    preferences: fields?.preferences ?? "",
  });
  return buildManualDraft(rawText, extracted, keywords);
}

export async function createManualJob(
  userId: string,
  payload: {
    folder_id?: string | null;
    company_name?: string;
    job_title?: string;
    recruitment_field?: string;
    job_description?: string;
    qualifications?: string;
    preferences?: string;
    industry?: string;
    deadline_raw?: string;
    deadline_date?: string | null;
    deadline_status?: DeadlineStatus;
    required_documents?: string;
    application_method?: string;
    raw_text: string;
    memo?: string;
    competency_keywords?: unknown;
    source_url?: string | null;
  }
) {
  const resolvedFolderId = await validateFolderId(userId, payload.folder_id ?? null);

  const jobTitle = payload.recruitment_field ?? payload.job_title ?? "";
  const fields = {
    company_name: payload.company_name ?? "",
    job_title: jobTitle,
    recruitment_field: jobTitle,
    job_description: payload.job_description ?? "",
    qualifications: payload.qualifications ?? "",
    preferences: payload.preferences ?? "",
    industry: payload.industry ?? "",
    deadline_raw: payload.deadline_raw ?? "",
    deadline_date: payload.deadline_date ?? null,
    required_documents: payload.required_documents ?? "",
    application_method: payload.application_method ?? "",
    raw_text: payload.raw_text,
  };
  const classification = classifyParseResult(
    { ...emptyFields(), ...fields },
    false
  );
  const keywords = normalizeStructuredKeywords(
    parseStructuredKeywords(payload.competency_keywords ?? [])
  );

  const row = {
    source_url: normalizeManualSourceUrl(payload.source_url),
    platform: "manual",
    parsing_status: classification.status,
    parse_failure_reason: null as string | null,
    folder_id: resolvedFolderId,
    ...fields,
    deadline_status: payload.deadline_status ?? null,
    memo: payload.memo ?? "",
    competency_keywords: keywords,
    is_image_based: false,
  };

  if (!isSupabaseConfigured()) {
    const job = devCreateJob(userId, row);
    return job;
  }

  const { data, error } = await supabaseAdmin
    .from("job_postings")
    .insert({ user_id: userId, ...row })
    .select()
    .single();

  if (error) {
    // 에러 객체를 버리면 원인을 알 길이 없다. 004 미적용이 "잠시 후 다시 시도해 주세요"로
    // 둔갑해 디버깅이 막혔던 이력이 있어 반드시 남긴다.
    console.error("[createManualJob] insert failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    // 수동 공고는 source_url=null + platform='manual'을 쓴다. 004_manual_add.sql이
    // 적용되지 않은 DB에서는 NOT NULL(23502)이나 enum 미존재(22P02)로 떨어진다.
    if (isMissingManualAddMigration(error)) {
      throw new AppError(
        500,
        "서버 DB 스키마가 최신이 아니에요. 관리자에게 문의해 주세요. (마이그레이션 004_manual_add.sql 미적용)",
        "schema_outdated"
      );
    }

    // 원문 링크를 받으므로 (user_id, source_url) unique index에 실제로 걸릴 수 있다.
    if (error.code === "23505") {
      throw new AppError(409, "이미 저장된 공고입니다.", "duplicate_url");
    }

    throw new AppError(500, "공고 저장에 실패했습니다.", "save_failed");
  }

  // 저장은 이미 커밋됐다. 분석 로깅 실패가 성공한 저장을 실패로 보이게 하면
  // 사용자가 다시 눌러 행이 중복 생성된다 (수동 공고는 source_url이 NULL이라
  // unique index가 막아주지 못한다).
  try {
    await logEvent(userId, "manual_created", {
      job_id: data.id,
      folder_id: resolvedFolderId,
    });
  } catch (err) {
    console.error("[createManualJob] logEvent failed (저장은 성공)", err);
  }

  return normalizeJobRow(data);
}

/**
 * 수동 추가의 원문 링크 정규화.
 * - 빈 문자열은 반드시 null로 — ''로 저장하면 링크 없는 두 번째 공고가
 *   (user_id, source_url) unique index에 걸린다. NULL끼리는 충돌하지 않는다.
 * - 스킴이 없으면 https://를 붙인다. 스킴 없는 값은 <a href>에서 상대 경로로
 *   해석되어 "원본 공고 보러가기" 링크가 깨진다.
 */
export function normalizeManualSourceUrl(
  input: string | null | undefined
): string | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** 004_manual_add.sql 미적용으로 인한 insert 실패인지. */
export function isMissingManualAddMigration(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  // 23502: source_url NOT NULL 위반, 22P02: platform_type에 'manual' 없음
  if (error.code === "23502" || error.code === "22P02") return true;
  return /invalid input value for enum platform_type/i.test(error.message ?? "");
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
