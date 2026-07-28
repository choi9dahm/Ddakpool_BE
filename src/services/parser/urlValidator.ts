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
  const FORMAT_ERROR =
    "* 올바른 URL 형식이 아니에요. 채용공고 페이지 주소를 다시 확인해 주세요.";
  const PLATFORM_ERROR =
    "* 아직 지원하지 않는 플랫폼이에요. 지금은 사람인과 잡코리아 공고를 저장할 수 있어요.";

  if (!trimmed) {
    return {
      valid: false,
      code: "url_format",
      message: FORMAT_ERROR,
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return {
      valid: false,
      code: "url_format",
      message: FORMAT_ERROR,
    };
  }

  // 한글·임의 문자열에 https://만 붙으면 URL 파서가 통과하므로,
  // 호스트에 도메인(.)이 있고 라벨이 비어 있지 않은지 추가로 검사한다.
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (
    !host ||
    !host.includes(".") ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    host.split(".").some((part) => !part)
  ) {
    return {
      valid: false,
      code: "url_format",
      message: FORMAT_ERROR,
    };
  }

  // 사람인 본도메인 + 단축 링크(saram.in)
  if (
    host === "saram.in" ||
    host.endsWith(".saram.in") ||
    host.includes("saramin.co.kr")
  ) {
    return { valid: true, platform: "saramin", normalizedUrl: url.toString() };
  }

  // 잡코리아 본도메인 + 단축 링크(joburl.kr)
  if (
    host === "joburl.kr" ||
    host.endsWith(".joburl.kr") ||
    host.includes("jobkorea.co.kr")
  ) {
    return { valid: true, platform: "jobkorea", normalizedUrl: url.toString() };
  }

  return {
    valid: false,
    code: "unsupported_platform",
    message: PLATFORM_ERROR,
  };
}
