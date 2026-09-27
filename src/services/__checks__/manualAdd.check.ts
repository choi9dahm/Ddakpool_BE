/**
 * 수동 추가 파이프라인 회귀 가드. 네트워크/LLM 호출 없이 `buildManualDraft`(순수 변환)만 검증한다.
 * 실행: npx tsx src/services/__checks__/manualAdd.check.ts
 *
 * 지키는 것: URL 경로(mergeLlmFields)는 시작일 오인 위험 때문에 LLM이 준 마감일을 버리지만,
 * 수동 경로는 파서 대체값이 없으므로 LLM 마감일을 그대로 채택해야 한다. 이 가드가 없으면
 * "수동 추가 공고는 마감일이 영원히 비어 D-day가 안 뜬다"는 회귀가 조용히 재발한다.
 */
import assert from "node:assert/strict";
import { buildManualDraft } from "../jobService.js";
import type { ExtractedJobFields } from "../llm/FieldExtractor.js";

function fakeExtracted(overrides: Partial<ExtractedJobFields> = {}): ExtractedJobFields {
  return {
    company_name: "딱풀랩",
    job_title: "백엔드 엔지니어",
    recruitment_field: "백엔드 엔지니어",
    job_description: "서버 개발",
    qualifications: "Node.js 3년 이상",
    preferences: "TypeScript 경험",
    industry: "IT",
    deadline_raw: "2026.10.31",
    deadline_date: "2026-10-31",
    required_documents: "이력서",
    application_method: "이메일",
    raw_text: "",
    is_image_based: false,
    ...overrides,
  };
}

// 1. LLM이 마감일을 줬으면 그대로 채택돼야 한다 (URL 경로처럼 버리면 안 됨).
{
  const draft = buildManualDraft("원문 텍스트", fakeExtracted(), []);
  assert.equal(draft.deadline_date, "2026-10-31", "LLM 마감일이 채택돼야 함");
  assert.equal(draft.company_name, "딱풀랩");
  assert.equal(draft.recruitment_field, draft.job_title, "모집분야=직무명 동기화");
  assert.equal(draft.platform, "manual");
  assert.equal(draft.source_url, null);
}

// 2. 이미지 URL이 텍스트에 섞여 있어도(휴리스틱이 true를 낼 법한 입력) is_image_based는 항상 false.
//    → true였다면 parseAndCreateJob과 달리 키워드 추출을 스킵하지 않아야 하는데, 여기선
//      애초에 is_image_based 자체가 항상 false로 고정되는지만 확인.
{
  const draft = buildManualDraft(
    "짧은 텍스트 https://x.com/a.png",
    fakeExtracted({ is_image_based: true }),
    []
  );
  assert.equal(draft.is_image_based, false, "수동 경로는 is_image_based 항상 false");
}

// 3. 추출 실패(null) 시에도 죽지 않고 빈 필드 draft를 반환해야 한다.
{
  const draft = buildManualDraft("아무 텍스트", null, []);
  assert.equal(draft.company_name, "");
  assert.equal(draft.deadline_date, null);
  assert.equal(draft.parsing_status, "partial", "빈 필드지만 raw_text는 있으니 partial");
}

console.log("manualAdd.check.ts: OK (3 assertions)");
