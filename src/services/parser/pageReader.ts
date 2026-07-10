import { chromium, type Browser } from "playwright";
import type { Platform } from "./urlValidator.js";

export interface PageFetchResult {
  html: string;
  text: string;
  httpStatus: number;
  failureReason?: "not_found" | "login_required" | "timeout" | "blocked" | "parse_error";
}

const PLATFORM_SELECTORS: Record<Platform, string> = {
  saramin: "h1, .job_tit, .posting_title, .wrap_jview",
  jobkorea: ".tit_job, .coName, .recruit_job_info, h1",
};

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    });
  }
  return browser;
}

export async function closePageReader(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export async function fetchRenderedPage(
  url: string,
  platform: Platform,
  timeoutMs: number
): Promise<PageFetchResult> {
  const debug = process.env.PARSE_DEBUG === "true";
  let page;

  try {
    const instance = await getBrowser();
    const context = await instance.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "ko-KR",
    });
    page = await context.newPage();

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const status = response?.status() ?? 0;

    if (status === 404) {
      return { html: "", text: "", httpStatus: 404, failureReason: "not_found" };
    }

    if (status === 401 || status === 403) {
      return {
        html: "",
        text: "",
        httpStatus: status,
        failureReason: "login_required",
      };
    }

    if (status >= 400) {
      return {
        html: "",
        text: "",
        httpStatus: status,
        failureReason: "blocked",
      };
    }

    const selector = PLATFORM_SELECTORS[platform];
    try {
      await page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 10000) });
    } catch {
      // Content may still be partially available
    }

    const html = await page.content();
    const text = (await page.innerText("body"))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50000);

    if (debug) {
      console.info(
        `[parse] platform=${platform} status=${status} htmlLen=${html.length} textLen=${text.length}`
      );
    }

    if (!text.trim()) {
      return {
        html,
        text: "",
        httpStatus: status,
        failureReason: "parse_error",
      };
    }

    return { html, text, httpStatus: status };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.message.includes("Timeout") ||
        err.message.includes("timeout"));

    if (debug) {
      console.warn("[parse] pageReader error:", err);
    }

    return {
      html: "",
      text: "",
      httpStatus: 0,
      failureReason: isTimeout ? "timeout" : "parse_error",
    };
  } finally {
    await page?.context().close().catch(() => undefined);
  }
}
