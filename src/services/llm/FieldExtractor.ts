import type { ParsedFields } from "../parser/index.js";

const PRIMARY_MODEL = "gpt-5-nano";
const FALLBACK_MODEL = "gpt-4.1-nano";
const MAX_INPUT_CHARS = 6000;

const SYSTEM_PROMPT =
  "You extract structured job posting fields from Korean recruitment page text. Return only valid JSON matching the schema. Use empty string for unknown fields. deadline_date must be YYYY-MM-DD or null.";

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
  constructor(private apiKey: string) {}

  async extract(rawText: string): Promise<ParsedFields | null> {
    const trimmed = rawText.trim().slice(0, MAX_INPUT_CHARS);
    if (!trimmed) return null;

    const primary = await this.requestFields(PRIMARY_MODEL, trimmed);
    if (primary) return primary;

    const fallback = await this.requestFields(FALLBACK_MODEL, trimmed);
    return fallback;
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
          temperature: 0,
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
    recruitment_field: String(parsed.recruitment_field ?? parsed.job_title ?? "").trim(),
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

  if (provider === "openai" && apiKey) {
    return new OpenAIFieldExtractor(apiKey);
  }

  return new StubFieldExtractor();
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
