export interface KeywordExtractor {
  extract(input: {
    qualifications: string;
    preferences: string;
  }): Promise<string[]>;
}

const SYSTEM_PROMPT =
  "Extract competency keywords from job qualifications and preferences. Return JSON array of strings only, max 30 items, each max 15 Korean chars or 20 English chars.";

export class StubKeywordExtractor implements KeywordExtractor {
  async extract(input: {
    qualifications: string;
    preferences: string;
  }): Promise<string[]> {
    const text = `${input.qualifications} ${input.preferences}`;
    const tokens = text
      .split(/[,·\n/|]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && t.length <= 20);

    const unique = [...new Set(tokens)];
    return unique.slice(0, 10);
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
  }): Promise<string[]> {
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
  ): Promise<string[] | null> {
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
      const parsed = JSON.parse(content) as string[];
      return normalizeKeywords(parsed);
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

export function normalizeKeywords(keywords: string[]): string[] {
  return keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .filter((k) => k.length <= 20)
    .slice(0, 30);
}
