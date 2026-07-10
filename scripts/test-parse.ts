import { fetchAndParse } from "../src/services/parser/index.ts";
import { closePageReader } from "../src/services/parser/pageReader.ts";

async function main() {
  const url = process.argv[2];
  const platform = (process.argv[3] ?? "saramin") as "saramin" | "jobkorea";
  const timeout = Number(process.argv[4] ?? 30000);

  if (!url) {
    console.error("Usage: tsx scripts/test-parse.ts <url> [platform] [timeoutMs]");
    process.exit(1);
  }

  const start = Date.now();
  const result = await fetchAndParse(url, platform, timeout);
  console.log(
    JSON.stringify(
      {
        elapsedMs: Date.now() - start,
        fetchFailed: result.fetchFailed,
        failureReason: result.failureReason ?? null,
        company: result.fields.company_name,
        title: result.fields.job_title,
        rawLen: result.fields.raw_text.length,
        textPreview: result.fields.raw_text.slice(0, 200),
      },
      null,
      2
    )
  );
  await closePageReader();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
