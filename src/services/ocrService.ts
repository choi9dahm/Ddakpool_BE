import { randomUUID } from "node:crypto";

// CLOVA OCR(General) API 클라이언트. 원격 이미지(자동 파싱)와 사용자 업로드 이미지가
// recognizeBuffer를 공유한다. 상세 설계: docs/ocr-feature-spec.md 5절.

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 업로드 라우트와 동일한 4MB 상한

interface ClovaOcrResponse {
  images?: { fields?: { inferText?: string; lineBreak?: boolean }[] }[];
}

function clovaConfig(): { secretKey: string; apiUrl: string } | null {
  const secretKey = process.env.CLOVA_OCR_SECRET_KEY;
  const apiUrl = process.env.CLOVA_OCR_API_URL;
  if (!secretKey || !apiUrl) return null;
  return { secretKey, apiUrl };
}

export function imageFormatFromContentType(contentType: string | null): string | null {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("bmp")) return "bmp";
  if (type.includes("tif")) return "tiff";
  return null;
}

/**
 * CLOVA fields(단어 단위)를 lineBreak 기준으로 이어붙인다.
 * lineBreak=true인 단어 뒤는 줄바꿈, 그 외엔 공백 — 단어마다 줄바꿈되는 것을 막는다.
 */
export function joinClovaFields(
  fields: { inferText?: string; lineBreak?: boolean }[]
): string {
  let text = "";
  let prevLineBreak = false;
  for (const field of fields) {
    const inferText = field.inferText ?? "";
    if (!inferText) continue;
    if (text) text += prevLineBreak ? "\n" : " ";
    text += inferText;
    prevLineBreak = Boolean(field.lineBreak);
  }
  return text;
}

/** 이미지 버퍼를 CLOVA OCR(General)로 인식해 텍스트를 순서대로 이어붙여 반환. 실패 시 빈 문자열(best-effort). */
export async function recognizeBuffer(
  buffer: Buffer,
  format: string = "jpg"
): Promise<string> {
  const config = clovaConfig();
  if (!config) {
    console.warn("ocrService: CLOVA_OCR_SECRET_KEY/CLOVA_OCR_API_URL 미설정, OCR 스킵");
    return "";
  }

  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "X-OCR-SECRET": config.secretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "V2",
        requestId: randomUUID(),
        timestamp: Date.now(),
        images: [{ format, name: "image", data: buffer.toString("base64") }],
      }),
    });

    if (!response.ok) {
      console.warn(`ocrService: CLOVA OCR 호출 실패 status=${response.status}`);
      return "";
    }

    const data = (await response.json()) as ClovaOcrResponse;
    return joinClovaFields(data.images?.[0]?.fields ?? []);
  } catch (err) {
    console.warn("ocrService: CLOVA OCR 호출 에러:", err);
    return "";
  }
}

async function fetchImageBuffer(
  url: string,
  refererUrl: string | undefined,
  timeoutMs: number
): Promise<{ data: Buffer; format: string } | null> {
  if (timeoutMs <= 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        ...FETCH_HEADERS,
        // 일부 CDN이 Referer 없는 요청을 막을 수 있어 원본 공고 URL을 붙인다(spec 5절, 미검증).
        ...(refererUrl ? { Referer: refererUrl } : {}),
      },
    });

    if (!response.ok) return null;

    const format = imageFormatFromContentType(response.headers.get("content-type"));
    if (!format) return null;

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) return null;

    return { data: Buffer.from(arrayBuffer), format };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 원격 이미지 URL 목록을 시간 예산(budgetMs) 안에서 순서대로 OCR, 인식된 텍스트를 이어붙여 반환.
 * 개별 이미지 fetch/OCR 실패는 조용히 스킵(best-effort) — 전체 파싱을 막지 않는다.
 */
export async function recognizeRemoteImages(
  urls: string[],
  budgetMs: number,
  refererUrl?: string
): Promise<string> {
  const maxImages = Number(process.env.OCR_MAX_IMAGES ?? 6);
  const targets = urls.slice(0, Math.max(maxImages, 0));
  const deadline = Date.now() + budgetMs;

  // ponytail: 순차 호출 고정(동시성 없음) = 이미지 많을수록 느려짐.
  // 동시 파싱 요청 늘면 CLOVA 요금제 TPS 한도 확인 후 동시성 조절.
  const texts: string[] = [];
  for (const url of targets) {
    if (Date.now() >= deadline) break;

    const image = await fetchImageBuffer(url, refererUrl, deadline - Date.now());
    if (!image) continue;

    const text = await recognizeBuffer(image.data, image.format);
    if (text.trim()) texts.push(text.trim());
  }

  return texts.join("\n");
}

if (process.argv[1] && /ocrService\.(ts|js)$/.test(process.argv[1])) {
  // 자가 점검: `npx tsx src/services/ocrService.ts` — 네트워크 호출 없는 순수 로직만 확인.
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`self-check failed: ${msg}`);
  };

  assert(imageFormatFromContentType("image/png") === "png", "png content-type");
  assert(imageFormatFromContentType("image/jpeg; charset=binary") === "jpg", "jpeg content-type");
  assert(imageFormatFromContentType("text/html") === null, "non-image content-type rejected");

  assert(
    joinClovaFields([
      { inferText: "담당업무", lineBreak: true },
      { inferText: "백엔드", lineBreak: false },
      { inferText: "개발", lineBreak: true },
      { inferText: "자격요건", lineBreak: true },
    ]) === "담당업무\n백엔드 개발\n자격요건",
    "lineBreak 기준 단어는 공백, 줄끝은 개행으로 결합"
  );

  recognizeRemoteImages([], 1000).then((text) => {
    assert(text === "", "empty url list returns empty string without network calls");
    console.log("ocrService self-check passed");
  });
}
