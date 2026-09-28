/**
 * 수동 추가 파이프라인 회귀 가드. 네트워크/LLM 호출 없이 `buildManualDraft`(순수 변환)만 검증한다.
 * 실행: npx tsx src/services/__checks__/manualAdd.check.ts
 *
 * 지키는 것: URL 경로(mergeLlmFields)는 시작일 오인 위험 때문에 LLM이 준 마감일을 버리지만,
 * 수동 경로는 파서 대체값이 없으므로 LLM 마감일을 그대로 채택해야 한다. 이 가드가 없으면
 * "수동 추가 공고는 마감일이 영원히 비어 D-day가 안 뜬다"는 회귀가 조용히 재발한다.
 */
import assert from "node:assert/strict";
import {
  buildManualDraft,
  isMissingManualAddMigration,
  normalizeManualSourceUrl,
} from "../jobService.js";
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

// 4. 004_manual_add.sql 미적용 시 실제로 나는 Postgres 에러들을 정확히 잡아내야 한다.
//    이 분류가 틀리면 "잠시 후 다시 시도해 주세요"로 뭉개져 원인을 알 수 없게 된다
//    (실제로 이 일이 있었음 — 수동 추가 저장 실패 진단 지연의 원인).
{
  assert.equal(
    isMissingManualAddMigration({ code: "23502" }),
    true,
    "source_url NOT NULL 위반(23502)을 잡아야 함"
  );
  assert.equal(
    isMissingManualAddMigration({ code: "22P02" }),
    true,
    "platform enum에 'manual' 없음(22P02)을 잡아야 함"
  );
  assert.equal(
    isMissingManualAddMigration({
      message: 'invalid input value for enum platform_type: "manual"',
    }),
    true,
    "code 없이 message만 와도 잡아야 함"
  );
  assert.equal(
    isMissingManualAddMigration({ code: "23505", message: "duplicate key value" }),
    false,
    "무관한 에러(중복 등)까지 스키마 미적용으로 오분류하면 안 됨"
  );
  assert.equal(
    isMissingManualAddMigration({ code: "23503", message: "foreign key violation" }),
    false,
    "무관한 에러(FK 위반)까지 오분류하면 안 됨"
  );
}

// 5. 원문 링크 정규화. 빈 값이 ''로 저장되면 링크 없는 두 번째 공고가
//    (user_id, source_url) unique index에 걸려 "이미 저장된 공고입니다"가 뜬다.
//    스킴 없는 값은 <a href>에서 상대 경로가 되어 링크가 깨진다.
{
  assert.equal(normalizeManualSourceUrl(undefined), null, "미입력 → null");
  assert.equal(normalizeManualSourceUrl(null), null, "null → null");
  assert.equal(normalizeManualSourceUrl(""), null, "빈 문자열 → null (''로 저장 금지)");
  assert.equal(normalizeManualSourceUrl("   "), null, "공백만 → null");
  assert.equal(
    normalizeManualSourceUrl("example.com/jobs/1"),
    "https://example.com/jobs/1",
    "스킴 없으면 https:// 부착"
  );
  assert.equal(
    normalizeManualSourceUrl("https://example.com/jobs/1"),
    "https://example.com/jobs/1",
    "https는 그대로"
  );
  assert.equal(
    normalizeManualSourceUrl("http://example.com/jobs/1"),
    "http://example.com/jobs/1",
    "http도 그대로 (https로 바꾸지 않음)"
  );
  assert.equal(
    normalizeManualSourceUrl("  https://example.com/x  "),
    "https://example.com/x",
    "앞뒤 공백 제거"
  );
}

console.log("manualAdd.check.ts: OK (5 assertions)");
