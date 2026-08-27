import type { StructuredKeyword } from "../../lib/keywords.js";

export interface KeywordExtractor {
  extract(input: {
    qualifications: string;
    preferences: string;
  }): Promise<StructuredKeyword[]>;
}

const SYSTEM_PROMPT = `Extract competency keywords from job qualifications and preferences.
Exclude education-level requirements (e.g. "초대졸 이상", "학사 이상", "대졸", "석사 우대", "고졸 이상") — these are not competency keywords, skip them entirely.
Return JSON array of objects with fields:
- text: keyword string (max 15 Korean chars or 20 English chars)
- source_section: one of "자격요건", "우대사항", "기타"
- order: number starting from 0 within each section
- source: always "llm"
Max 30 items total.`;

// 학력 요건(예: '초대졸 이상', '학사 우대')은 역량 키워드가 아니므로 제외.
const EDUCATION_LEVEL_PATTERN =
  /(고졸|초대졸|대졸|전문학사|학사|석사|박사|대학원)\s*(이상|우대|졸업)?/;

export function stubSection(text: string, section: "자격요건" | "우대사항") {
  return text
    .split(/[,·\n/|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 20)
    .filter((t) => !EDUCATION_LEVEL_PATTERN.test(t))
    .map((textValue, order) => ({
      text: textValue,
      source_section: section,
      order,
      source: "llm" as const,
    }));
}

export class StubKeywordExtractor implements KeywordExtractor {
  async extract(input: {
    qualifications: string;
    preferences: string;
  }): Promise<StructuredKeyword[]> {
    const qual = stubSection(input.qualifications, "자격요건");
    const pref = stubSection(input.preferences, "우대사항");
    const unique = new Map<string, StructuredKeyword>();
    for (const kw of [...qual, ...pref]) {
      if (!unique.has(kw.text)) unique.set(kw.text, kw);
    }
    return [...unique.values()].slice(0, 10);
  }
}

export class OpenAIKeywordExtractor implements KeywordExtractor {
  constructor(
    private apiKey: string,
    private primaryModel: string,
    private fallbackModel: string
  ) {}

  async extract(input: {
    qualifications: string;
    preferences: string;
  }): Promise<StructuredKeyword[]> {
    if (!this.apiKey) return new StubKeywordExtractor().extract(input);

    const userContent = `자격 요건: ${input.qualifications}\n우대 사항: ${input.preferences}`;

    const primary = await this.requestKeywords(this.primaryModel, userContent);
    if (primary) return primary;

    if (this.fallbackModel !== this.primaryModel) {
      const fallback = await this.requestKeywords(
        this.fallbackModel,
        userContent
      );
      if (fallback) return fallback;
    }

    return new StubKeywordExtractor().extract(input);
  }

  private async requestKeywords(
    model: string,
    userContent: string
  ): Promise<StructuredKeyword[] | null> {
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
          // temperature는 이 모델(reasoning 계열)에서 1 고정, 변경 불가(400).
          // seed는 재현성 best-effort(OpenAI 비보장)라 변동을 줄이는 용도로만 사용.
          seed: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
      });

      if (!response.ok) {
        console.warn(`LLM request failed for model ${model}: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? "[]";
      const parsed = JSON.parse(content) as unknown;
      return normalizeStructuredKeywordsFromUnknown(parsed);
    } catch (err) {
      console.warn(`LLM request error for model ${model}:`, err);
      return null;
    }
  }
}

export function createKeywordExtractor(): KeywordExtractor {
  const provider = process.env.LLM_PROVIDER ?? "stub";
  const apiKey = process.env.LLM_API_KEY ?? "";
  const primaryModel = process.env.LLM_MODEL ?? "gpt-5-nano";
  const fallbackModel = process.env.LLM_FALLBACK_MODEL ?? "gpt-5-mini";

  if (provider === "openai" && apiKey) {
    return new OpenAIKeywordExtractor(apiKey, primaryModel, fallbackModel);
  }

  return new StubKeywordExtractor();
}

export function normalizeStructuredKeywordsFromUnknown(
  value: unknown
): StructuredKeyword[] {
  if (!Array.isArray(value)) return [];

  const result: StructuredKeyword[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) continue;
      result.push({
        text: text.slice(0, 20),
        source_section: "기타",
        order: index,
        source: "llm",
      });
      continue;
    }

    if (item && typeof item === "object" && "text" in item) {
      const raw = item as Partial<StructuredKeyword>;
      const text = String(raw.text ?? "").trim();
      if (!text) continue;
      const section = raw.source_section;
      const sourceSection =
        section === "자격요건" || section === "우대사항" || section === "기타"
          ? section
          : "기타";
      result.push({
        text: text.slice(0, 20),
        source_section: sourceSection,
        order: typeof raw.order === "number" ? raw.order : index,
        source: raw.source === "user" ? "user" : "llm",
      });
    }
  }

  return result.slice(0, 30);
}

export function normalizeKeywords(keywords: string[]): StructuredKeyword[] {
  return keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .filter((k) => k.length <= 20)
    .slice(0, 30)
    .map((text, order) => ({
      text,
      source_section: "기타" as const,
      order,
      source: "user" as const,
    }));
}

if (process.argv[1] && /KeywordExtractor\.(ts|js)$/.test(process.argv[1])) {
  // 자가 점검: `npx tsx src/services/llm/KeywordExtractor.ts`
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`self-check failed: ${msg}`);
  };

  const texts = stubSection("초대졸 이상, React, 학사 우대, TypeScript", "자격요건").map(
    (k) => k.text
  );
  assert(!texts.includes("초대졸 이상"), "학력 요건(초대졸 이상) 제외");
  assert(!texts.includes("학사 우대"), "학력 요건(학사 우대) 제외");
  assert(texts.includes("React") && texts.includes("TypeScript"), "역량 키워드는 유지");

  console.log("KeywordExtractor self-check passed");
}
