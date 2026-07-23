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
  "- job_description: '주요업무/담당업무/직무 내용'에 해당하는 내용만. 회사소개, 슬로건(WE ARE 등), 인재상, 자격요건, 우대사항, 복리후생, 근무조건, 근무지, 근무시간, 채용절차, 접수방법, 제출서류, 유의사항은 절대 포함하지 말 것. 담당업무 섹션만 잘라 넣고, 그 앞뒤 전체 본문을 넣지 말 것.",
  "- qualifications: 자격요건/지원자격 등 지원에 필요한 '필수' 요건만.",
  "- preferences: '우대', '~하면 우대' 처럼 우대 조건으로 명시된 지원자 자격만. 근무제도/근무형태/근무시간/복리후생/급여는 여기에 넣지 말 것(해당 없으면 빈 문자열).",
  "- industry: 업종.",
  "- deadline_raw: '마감일/접수 마감일'의 원문. 상시채용/수시채용/'상시 채용중'/'~ 상시'이면 정확히 '상시채용'. '채용시 마감'은 상시채용이 아니므로 빈 문자열. 시작일/등록일/게시일은 넣지 말 것. 없으면 빈 문자열.",
  "- deadline_date: 마감일을 YYYY-MM-DD로. 마감일이 없거나 상시/수시채용이면 null.",
  "- required_documents: 제출/접수 서류.",
  "- application_method: 지원/접수 방법.",
  "- is_image_based: true if the posting body is primarily images/screenshots with little extractable text (이미지형 채용공고).",
  "  Strong signals: '[상세요강 이미지]' section present, body is mostly image URLs (.png/.jpg), or detail text is only short SEO keywords while the real JD is an image.",
  "  Otherwise false.",
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
    is_image_based: { type: "boolean" },
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
    "is_image_based",
  ],
} as const;

export interface ExtractedJobFields extends ParsedFields {
  is_image_based: boolean;
}

export interface FieldExtractor {
  extract(rawText: string): Promise<ExtractedJobFields | null>;
}

export class StubFieldExtractor implements FieldExtractor {
  async extract(): Promise<ExtractedJobFields | null> {
    return null;
  }
}

export class OpenAIFieldExtractor implements FieldExtractor {
  constructor(
    private apiKey: string,
    private primaryModel: string,
    private fallbackModel: string
  ) {}

  async extract(rawText: string): Promise<ExtractedJobFields | null> {
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
  ): Promise<ExtractedJobFields | null> {
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

      const parsed = JSON.parse(content) as Omit<ParsedFields, "raw_text"> & {
        is_image_based?: boolean;
      };
      return normalizeExtractedFields(parsed, rawText);
    } catch (err) {
      console.warn(`FieldExtractor error for ${model}:`, err);
      return null;
    }
  }
}

function normalizeExtractedFields(
  parsed: Omit<ParsedFields, "raw_text"> & { is_image_based?: boolean },
  rawText: string
): ExtractedJobFields {
  return {
    company_name: String(parsed.company_name ?? "").trim(),
    job_title: String(parsed.job_title ?? "").trim(),
    // 모집 분야는 항상 파싱된 직무명과 동일한 값을 사용한다. (JD-DP-INS-01 / JD-DP-03)
    recruitment_field: String(parsed.job_title ?? "").trim(),
    job_description: sanitizeJobDescription(
      String(parsed.job_description ?? "").trim()
    ),
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
    is_image_based: Boolean(parsed.is_image_based),
  };
}

/**
 * 담당업무에 회사소개·자격요건 등 타 섹션이 섞여 들어오면 잘라낸다.
 * (예: WE ARE ~ 인재상까지 통째로 들어오는 사람인 케이스)
 */
function sanitizeJobDescription(desc: string): string {
  if (!desc) return "";
  let text = desc;

  // '담당업무/주요업무' 헤더가 있으면 그 이후만 사용
  const dutyHeader = text.match(
    /(?:^|\n)\s*(?:담당\s*업무|주요\s*업무|직무\s*내용|Job\s*Description)\s*[:：]?\s*\n([\s\S]+)/i
  );
  if (dutyHeader?.[1]) {
    text = dutyHeader[1].trim();
  }

  // 뒤따르는 타 섹션에서 절단
  const cut = text.search(
    /\n\s*(?:자격\s*요건|지원\s*자격|우대\s*사항|우대\s*조건|복리\s*후생|채용\s*절차|전형\s*절차|근무\s*조건|근무\s*환경|인재상|회사\s*소개|복지|Benefits|Requirements|Qualifications|WE\s*ARE|우리는)\b/i
  );
  if (cut > 40) {
    text = text.slice(0, cut).trim();
  }

  // 앞부분에 회사 슬로건/소개가 길게 붙어 있으면 담당업무 불릿부터 시작하도록 보정
  if (/WE\s*ARE|어메스는|인재를 기다리/i.test(text) && /[•·▪‣-]/.test(text)) {
    const bullet = text.search(/(?:^|\n)\s*[•·▪‣\-]/m);
    if (bullet > 0) text = text.slice(bullet).trim();
  }

  return text.trim();
}

/** 휴리스틱: 상세요강이 이미지 중심이면 이미지형으로 본다. */
export function detectImageBasedHeuristic(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) return false;

  if (/\[이미지\]|이미지형|캡처\s*이미지|본문이\s*이미지/i.test(trimmed)) {
    return true;
  }

  const imageUrls =
    trimmed.match(/(?:https?:)?\/\/\S+\.(?:png|jpe?g|gif|webp)/gi) ?? [];
  const hasImageSection = /\[상세요강 이미지\]/i.test(trimmed);

  // 파서가 상세요강 이미지를 분리해 둔 경우: 상세 텍스트가 짧으면 이미지형
  if (hasImageSection) {
    const detailMatch = trimmed.match(
      /\[상세요강\]\n([\s\S]*?)(?=\n\[|$)/
    );
    const detailText = (detailMatch?.[1] ?? "").trim();
    if (detailText.length < 400) return true;
    if (imageUrls.length >= 1 && detailText.length < 800) return true;
  }

  // 이미지 URL은 있는데 본문 텍스트가 거의 없는 경우
  const withoutUrls = trimmed
    .replace(/(?:https?:)?\/\/\S+/gi, "")
    .replace(/\[상세요강 이미지\]/gi, "")
    .trim();
  if (imageUrls.length >= 1 && withoutUrls.length < 250) return true;
  if (imageUrls.length >= 2 && withoutUrls.length < 500) return true;

  return false;
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
  extracted: ExtractedJobFields
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

export function resolveIsImageBased(
  rawText: string,
  extracted: ExtractedJobFields | null
): boolean {
  if (extracted?.is_image_based) return true;
  return detectImageBasedHeuristic(rawText);
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
