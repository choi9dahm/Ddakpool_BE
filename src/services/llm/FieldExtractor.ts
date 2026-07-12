import type { ParsedFields } from "../parser/index.js";

const MAX_INPUT_CHARS = 12000;

const SYSTEM_PROMPT = [
  "You are an expert at parsing Korean job postings.",
  "Given the raw text of one job posting, split it into structured fields and return ONLY valid JSON matching the schema.",
  "Assign each piece of content to the single most appropriate field. Never mix unrelated content into a field.",
  "Field rules:",
  "- company_name: 채용하는 회사명.",
  "- job_title: 공고 제목.",
  "- recruitment_field: 모집 직무/부문 (예: 'RM 부정거래 모니터링 어시스턴트').",
  "- job_description: '주요업무/담당업무/직무 내용'에 해당하는 내용만. 회사소개, 자격요건, 우대사항, 복리후생, 근무조건, 근무지, 근무시간, 채용절차, 접수방법, 제출서류, 유의사항은 절대 포함하지 말 것.",
  "- qualifications: 자격요건/지원자격 등 지원에 필요한 '필수' 요건만.",
  "- preferences: '우대', '~하면 우대' 처럼 우대 조건으로 명시된 지원자 자격만. 근무제도/근무형태/근무시간/복리후생/급여는 여기에 넣지 말 것(해당 없으면 빈 문자열).",
  "- industry: 업종.",
  "- deadline_raw: '마감일/접수 마감일'의 원문 텍스트만. '시작일/등록일/게시일'이나 '상시채용/수시채용'은 절대 넣지 말 것(빈 문자열).",
  "- deadline_date: 마감일을 YYYY-MM-DD로. 마감일이 없거나 상시/수시채용이면 null.",
  "- required_documents: 제출/접수 서류.",
  "- application_method: 지원/접수 방법.",
  "Preserve bullet points and line breaks within list-like fields. Use an empty string for any field not present in the text.",
].join("\n");

const FIELD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    company_name: { type: "string" },
    job_title: { type: "string" },
    recruitment_field: { type: "string" },
    job_description: { type: "string" },
    qualifications: { type: "string" },
    preferences: { type: "string" },
    industry: { type: "string" },
    deadline_raw: { type: "string" },
    deadline_date: { type: ["string", "null"] },
    required_documents: { type: "string" },
    application_method: { type: "string" },
  },
  required: [
    "company_name",
    "job_title",
    "recruitment_field",
    "job_description",
    "qualifications",
    "preferences",
    "industry",
    "deadline_raw",
    "deadline_date",
    "required_documents",
    "application_method",
  ],
} as const;

export interface FieldExtractor {
  extract(rawText: string): Promise<ParsedFields | null>;
}

export class StubFieldExtractor implements FieldExtractor {
  async extract(): Promise<ParsedFields | null> {
    return null;
  }
}

export class OpenAIFieldExtractor implements FieldExtractor {
  constructor(
    private apiKey: string,
    private primaryModel: string,
    private fallbackModel: string
  ) {}

  async extract(rawText: string): Promise<ParsedFields | null> {
    const trimmed = rawText.trim().slice(0, MAX_INPUT_CHARS);
    if (!trimmed) return null;

    const primary = await this.requestFields(this.primaryModel, trimmed);
    if (primary) return primary;

    if (this.fallbackModel !== this.primaryModel) {
      const fallback = await this.requestFields(this.fallbackModel, trimmed);
      if (fallback) return fallback;
    }

    return null;
  }

  private async requestFields(
    model: string,
    rawText: string
  ): Promise<ParsedFields | null> {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          reasoning_effort: "minimal",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `채용공고 본문:\n${rawText}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "job_posting_fields",
              strict: true,
              schema: FIELD_SCHEMA,
            },
          },
        }),
      });

      if (!response.ok) {
        console.warn(`FieldExtractor failed for ${model}: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content) as Omit<ParsedFields, "raw_text">;
      return normalizeExtractedFields(parsed, rawText);
    } catch (err) {
      console.warn(`FieldExtractor error for ${model}:`, err);
      return null;
    }
  }
}

function normalizeExtractedFields(
  parsed: Omit<ParsedFields, "raw_text">,
  rawText: string
): ParsedFields {
  return {
    company_name: String(parsed.company_name ?? "").trim(),
    job_title: String(parsed.job_title ?? "").trim(),
    // 모집 분야는 항상 파싱된 직무명과 동일한 값을 사용한다. (JD-DP-INS-01 / JD-DP-03)
    recruitment_field: String(parsed.job_title ?? "").trim(),
    job_description: String(parsed.job_description ?? "").trim(),
    qualifications: String(parsed.qualifications ?? "").trim(),
    preferences: String(parsed.preferences ?? "").trim(),
    industry: String(parsed.industry ?? "").trim(),
    deadline_raw: String(parsed.deadline_raw ?? "").trim(),
    deadline_date:
      parsed.deadline_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline_date)
        ? parsed.deadline_date
        : null,
    required_documents: String(parsed.required_documents ?? "").trim(),
    application_method: String(parsed.application_method ?? "").trim(),
    raw_text: rawText,
  };
}

export function createFieldExtractor(): FieldExtractor {
  const provider = process.env.LLM_PROVIDER ?? "stub";
  const apiKey = process.env.LLM_API_KEY ?? "";
  const primaryModel = process.env.LLM_MODEL ?? "gpt-5-nano";
  const fallbackModel = process.env.LLM_FALLBACK_MODEL ?? "gpt-5-mini";

  if (provider === "openai" && apiKey) {
    return new OpenAIFieldExtractor(apiKey, primaryModel, fallbackModel);
  }

  return new StubFieldExtractor();
}

/**
 * LLM이 원문(B)에서 분류한 결과를 반영한다.
 * - 본문 성격 필드(담당업무/자격요건/우대사항/모집분야)는 LLM 값이 있으면 우선 사용.
 * - 구조화된 메타데이터(기업명/업종/서류/지원방법)는 파서(dt/dd) 값을 우선하고
 *   비어 있을 때만 LLM 값으로 보완한다.
 * - 마감일(deadline_raw/deadline_date)은 시작일/등록일 오인 위험이 있어
 *   LLM 결과를 쓰지 않고 파서(dt/dd) 값만 신뢰한다. (JD-DP-INS-08)
 * - raw_text(원문 스냅샷)는 항상 파서 값을 유지한다.
 */
export function mergeLlmFields(
  base: ParsedFields,
  extracted: ParsedFields
): ParsedFields {
  const merged = { ...base };

  const contentKeys: (keyof ParsedFields)[] = [
    "job_description",
    "qualifications",
    "preferences",
  ];
  for (const key of contentKeys) {
    const value = String(extracted[key] ?? "").trim();
    if (value) merged[key] = value;
  }

  const fallbackKeys: (keyof ParsedFields)[] = [
    "company_name",
    "job_title",
    "industry",
    "required_documents",
    "application_method",
  ];
  for (const key of fallbackKeys) {
    if (!String(merged[key] ?? "").trim() && String(extracted[key] ?? "").trim()) {
      merged[key] = extracted[key] as string;
    }
  }

  // 모집 분야는 직무명과 항상 동일하게 유지한다. (JD-DP-INS-01 / JD-DP-03)
  merged.recruitment_field = merged.job_title;

  return merged;
}

export function mergeParsedFields(
  base: ParsedFields,
  extracted: ParsedFields
): ParsedFields {
  const merged = { ...base };

  const stringKeys: (keyof ParsedFields)[] = [
    "company_name",
    "job_title",
    "recruitment_field",
    "job_description",
    "qualifications",
    "preferences",
    "industry",
    "deadline_raw",
    "required_documents",
    "application_method",
  ];

  for (const key of stringKeys) {
    if (!String(merged[key] ?? "").trim() && String(extracted[key] ?? "").trim()) {
      merged[key] = extracted[key] as string;
    }
  }

  if (!merged.deadline_date && extracted.deadline_date) {
    merged.deadline_date = extracted.deadline_date;
  }

  if (!merged.raw_text.trim() && extracted.raw_text.trim()) {
    merged.raw_text = extracted.raw_text;
  }

  return merged;
}
