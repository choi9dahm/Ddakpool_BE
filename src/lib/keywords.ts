export type KeywordSourceSection = "자격요건" | "우대사항" | "기타";
export type KeywordSource = "llm" | "user";

export interface StructuredKeyword {
  text: string;
  source_section: KeywordSourceSection;
  order: number;
  source: KeywordSource;
}

export function keywordTexts(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && "text" in item) {
        const text = (item as StructuredKeyword).text;
        return typeof text === "string" ? text.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
}

export function parseStructuredKeywords(value: unknown): StructuredKeyword[] {
  if (!Array.isArray(value)) {
    if (typeof value === "string") {
      try {
        return parseStructuredKeywords(JSON.parse(value) as unknown);
      } catch {
        return value.trim()
          ? [
              {
                text: value.trim(),
                source_section: "기타",
                order: 0,
                source: "llm",
              },
            ]
          : [];
      }
    }
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        return {
          text,
          source_section: "기타" as const,
          order: index,
          source: "llm" as const,
        };
      }
      if (item && typeof item === "object" && "text" in item) {
        const raw = item as Partial<StructuredKeyword>;
        const text = String(raw.text ?? "").trim();
        if (!text) return null;
        const section = raw.source_section;
        const sourceSection: KeywordSourceSection =
          section === "자격요건" || section === "우대사항" || section === "기타"
            ? section
            : "기타";
        return {
          text: text.slice(0, 20),
          source_section: sourceSection,
          order: typeof raw.order === "number" ? raw.order : index,
          source: raw.source === "user" ? "user" : "llm",
        };
      }
      return null;
    })
    .filter((item): item is StructuredKeyword => item !== null)
    .slice(0, 30);
}

export function normalizeStructuredKeywords(
  keywords: StructuredKeyword[]
): StructuredKeyword[] {
  return keywords
    .map((kw, index) => ({
      text: kw.text.trim().slice(0, 20),
      source_section: kw.source_section,
      order: kw.order ?? index,
      source: kw.source,
    }))
    .filter((kw) => kw.text.length > 0)
    .slice(0, 30);
}

export function normalizeKeywordTexts(keywords: string[]): StructuredKeyword[] {
  return normalizeStructuredKeywords(
    keywords.map((text, order) => ({
      text,
      source_section: "기타",
      order,
      source: "user" as const,
    }))
  );
}
