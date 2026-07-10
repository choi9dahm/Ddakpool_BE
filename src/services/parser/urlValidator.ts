export type Platform = "saramin" | "jobkorea";

export interface UrlValidationResult {
  valid: true;
  platform: Platform;
  normalizedUrl: string;
}

export interface UrlValidationError {
  valid: false;
  code: "url_format" | "unsupported_platform";
  message: string;
}

export function validateJobUrl(input: string): UrlValidationResult | UrlValidationError {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      valid: false,
      code: "url_format",
      message: "* 올바른 URL 형식이 아니에요. 채용공고 페이지 주소를 다시 확인해 주세요.",
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return {
      valid: false,
      code: "url_format",
      message: "* 올바른 URL 형식이 아니에요. 채용공고 페이지 주소를 다시 확인해 주세요.",
    };
  }

  const host = url.hostname.replace(/^www\./, "");

  if (host.includes("saramin.co.kr")) {
    return { valid: true, platform: "saramin", normalizedUrl: url.toString() };
  }

  if (host.includes("jobkorea.co.kr")) {
    return { valid: true, platform: "jobkorea", normalizedUrl: url.toString() };
  }

  return {
    valid: false,
    code: "unsupported_platform",
    message: "* 아직 지원하지 않는 플랫폼이에요. 지금은 사람인과 잡코리아 공고를 저장할 수 있어요.",
  };
}
