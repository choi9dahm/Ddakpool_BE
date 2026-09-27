# OCR 기능 명세 (CLOVA OCR)

상태: 초안 (계획 단계)
작성일: 2026-08-20
관련 코드: `src/services/parser/index.ts`, `src/services/parser/saraminDetail.ts`, `src/services/parser/jobkoreaDetail.ts`, `src/services/jobService.ts`, `src/services/llm/FieldExtractor.ts`, `src/routes/jobs.routes.ts`, `src/services/profileService.ts`

## 1. 배경

이미지형 채용공고(`is_image_based: true`)는 상세요강이 스크린샷/이미지로만 제공되어 `raw_text`, `job_description`, `qualifications` 등 핵심 필드가 비어있는 경우가 많다. 현재는 이런 공고에서 LLM 키워드 추출도 건너뛴다 (`jobService.ts:260`).

- 자동 파싱 시 Saramin/Jobkorea 상세 iframe에서 이미지 URL을 이미 수집 중이다 (`saraminDetail.ts`, `jobkoreaDetail.ts`의 `detailBody.imageUrls`). 지금은 이 URL을 `raw_text`에 `[상세요강 이미지]\nurl1\nurl2...` 형태로 그냥 나열만 하고 실제 텍스트로는 바꾸지 않는다.
- 사용자가 이미지를 직접 업로드하는 라우트도 이미 존재한다 (`POST /jobs/:id/images`). 저장만 하고 내용 추출은 안 함.

OCR로 이 이미지들에서 텍스트를 뽑아 `raw_text`에 채워 넣으면, 이미지형 공고도 필드 추출/키워드 추출 파이프라인을 그대로 태울 수 있다.

## 2. 범위

### MVP (이번 작업)
1. **원격 이미지 자동 OCR** — URL 파싱 중 Saramin/Jobkorea 상세 iframe에서 수집된 이미지(`detail_image_urls`)를 자동으로 OCR, `raw_text`에 삽입 후 기존 LLM 필드/키워드 추출 파이프라인에 그대로 흘려보냄. 사용자 조작 없이 `POST /jobs/parse` 응답에 반영됨.
2. **사용자 업로드 이미지 OCR** — `POST /jobs/:id/images`로 올린 이미지도 OCR, 결과를 저장하고 사용자가 명시적으로 요청하면(`POST /jobs/:id/ocr-fill`) 필드에 병합. 이미 값이 있는 필드와 OCR 결과가 충돌하면 덮어쓰기 전 확인 팝업을 거친다(4.3절).

두 경로 모두 같은 `ocrService`(CLOVA OCR API 호출)를 공유한다.

> **엔진 선정**: tesseract.js 대신 네이버 CLOVA OCR(General) 채택. 한글 문서 특화 학습 데이터로 Saramin/Jobkorea 같은 국문 채용공고에서 인식률이 더 높고, 외부 API 호출이라 서버 CPU 소모·워커 풀·언어팩 캐싱 문제가 사라짐(8절 참고). 유료 API이나 `OCR_MAX_IMAGES` 상한이 사실상 호출당 비용 캡을 겸하고, 무료 크레딧으로 초기 검증 가능. 외부 API 의존 리스크는 기존 best-effort 원칙(개별 이미지 실패는 스킵, 5절)으로 그대로 흡수.

### Out of scope (다음 단계, 필요해지면)
- 다국어 확장(현재 한국어 채용공고이므로 `kor+eng`만).
- OCR 결과 신뢰도 기반 재시도/이미지 전처리(이진화, 회전 보정 등) — 실사용 정확도 낮을 때 검토.
- 이미지 OCR 결과 캐싱(동일 URL 재파싱 시 재사용) — 현재 동일 `source_url`은 재파싱 자체가 `409 duplicate_url`로 막혀있어 캐싱 이득이 없음.

## 3. 처리 흐름

### 3.1 원격 이미지 자동 OCR (신규 in-scope)

```
[FE] POST /jobs/parse {url}
        │
        ▼
fetchAndParse() (parser/index.ts, 기존 로직 변경 없음)
        │  Saramin/Jobkorea 상세 iframe 파싱 시 detailBody.imageUrls를
        │  ParsedFields.detail_image_urls 로 그대로 얹어서 리턴 (신규 필드, 값은 기존에 이미 수집하던 것)
        ▼
jobService.parseAndCreateJob()
        │
        ├─ fetchAndParse 직후, classify/LLM 추출 이전에 훅 추가:
        │   if (!fetchFailed && fields.detail_image_urls.length > 0)
        │     ocrText = await recognizeRemoteImages(fields.detail_image_urls, OCR_TIMEOUT_MS)
        │     if (ocrText) fields.raw_text += "\n\n[상세요강 이미지 OCR]\n" + ocrText
        │
        ├─ classifyParseResult(fields, ...)          ← enrich된 raw_text로 재계산 (기존 로직 그대로)
        ├─ fieldExtractor.extract(fields.raw_text)    ← OCR 텍스트 포함해서 필드 추출 (기존 로직 그대로)
        ├─ mergeLlmFields / resolveIsImageBased        ← 기존 로직 그대로
        └─ keyword 추출 게이트 조건 변경 (아래 4절)
```

핵심: **주입 지점 1곳**(`parseAndCreateJob` 최상단, `fetchAndParse` 리턴 직후)만 건드리면 됨. `fetchAndParse` 내부의 3가지 하위 경로(Saramin AJAX / Jobkorea 페이지 / Playwright 폴백)는 전혀 손대지 않아도 이 훅이 공통으로 적용됨 — 모두 같은 `ParsedFields`를 리턴하기 때문.

### 3.2 사용자 업로드 이미지 OCR

```
[FE] 이미지 선택 → POST /jobs/:id/images (기존 라우트, 응답에 ocr_text 추가)
                         │
                         ├─ 업로드 저장 (기존: uploadJobImage)
                         └─ OCR 실행 (신규) → job_posting_images.ocr_text 저장

[FE] "이미지로 필드 채우기" 버튼 → POST /jobs/:id/ocr-fill (신규, body 없음)
                         │
                         ├─ 해당 job의 job_posting_images.ocr_text 전부 concat
                         ├─ FieldExtractor.extract 로 OCR 텍스트에서 필드 후보값 계산
                         ├─ 대상 필드(job_description/qualifications/preferences/company_name/industry/
                         │   required_documents/application_method) 중 기존 값이 있고 OCR 후보값과
                         │   다른 필드(충돌)가 1개 이상이면:
                         │     → 저장하지 않고 200 { status: "confirm_required", conflicts: [{field, current, ocr}] } 반환
                         │     → [FE] "이미지 기반 내용으로 필드값을 덮어씌우겠습니까?" 확인 팝업 노출
                         ├─ 충돌 없음(대상 필드가 전부 비어있거나 OCR 후보값과 동일) → 팝업 없이 바로 병합·저장
                         └─ 팝업에서 "확인" → POST /jobs/:id/ocr-fill { confirm: true } 재호출
                              ├─ 충돌 필드까지 포함해 OCR 후보값으로 덮어씀 (원래 비어있던 필드는 항상 채움)
                              ├─ mergeLlmFields 적용 후 KeywordExtractor 재실행
                              └─ job_postings 업데이트 후 반환
```

## 4. 필드/게이팅 조건 변경

### 4.1 `ParsedFields`에 `detail_image_urls: string[]` 추가
- `src/services/parser/index.ts`: `ParsedFields` 인터페이스에 필드 추가, `emptyFields()`/`parseSaramin`/`parseJobkorea`(HTML 직접 파싱 경로, detailBody 없음)는 `[]`로 채움.
- `src/services/parser/saraminDetail.ts`, `jobkoreaDetail.ts`: 이미 계산해둔 `detailBody.imageUrls`를 리턴 객체에 `detail_image_urls`로 그대로 노출만 하면 됨 (새 스크레이핑 로직 불필요).

### 4.2 키워드 추출 게이트 조건 (`jobService.ts:260`)
현재:
```ts
if (classification.status !== "fail" && !isImageBased) { ... }
```
변경 (OCR로 채워졌으면 `is_image_based`가 true여도 키워드를 뽑아야 함):
```ts
if (classification.status !== "fail" && (fields.qualifications.trim() || fields.preferences.trim())) { ... }
```
`is_image_based` 플래그(휴리스틱, 섹션 텍스트 길이 기반)에 의존하지 않고 실제 필드 내용 유무로 판단 — OCR 성공 여부와 무관하게 더 정확한 조건이기도 함.

### 4.3 필드 충돌 확인 정책 (신규)

`POST /jobs/:id/ocr-fill`이 덮어쓰려는 필드 중 이미 사용자가 입력/저장해 둔 값이 있고, 그 값이 OCR 후보값과 다르면 즉시 덮어쓰지 않는다.

- 비교 대상 필드: `job_description`, `qualifications`, `preferences`, `company_name`, `industry`, `required_documents`, `application_method` (3.2 참고). `deadline_raw`/`deadline_date`는 `mergeLlmFields`와 동일하게 대상에서 제외한다 — 마감일은 LLM/OCR 결과를 신뢰하지 않고 파서 값만 신뢰하는 기존 원칙(JD-DP-INS-08)을 그대로 따른다.
- 충돌 판정: 대상 필드 값이 비어있지 않고, OCR 후보값(트림 후 문자열 비교)과 다름.
- 충돌이 1개 이상이면 저장 없이 `confirm_required` 응답만 반환 → FE가 확인 팝업("이미지 기반 내용으로 필드값을 덮어씌우겠습니까?") 노출.
- 사용자가 확인하면 `confirm: true`로 동일 엔드포인트 재호출 — 충돌 필드 포함 전체를 OCR 후보값으로 덮어씀.
- 사용자가 취소하면 아무 요청도 보내지 않는다(기존 값 그대로 유지) — 취소 전용 API 불필요.
- 충돌이 없는 필드(원래 비어있던 필드)는 최초 호출에서 팝업 없이 바로 채워진다 — `confirm` 파라미터와 무관하게 항상 채움 대상.

## 5. 서비스 레이어: `src/services/ocrService.ts` (신규)

```ts
// CLOVA OCR(General) API 호출. POST {CLOVA_OCR_API_URL}, 헤더 X-OCR-SECRET: {CLOVA_OCR_SECRET_KEY},
// body에 base64 인코딩 이미지 포함 → 응답 images[].fields[].inferText를 순서대로 이어붙여 리턴
export async function recognizeBuffer(buffer: Buffer): Promise<string>

// 원격 이미지 URL 목록을 받아 시간 예산 안에서 OCR, 인식된 텍스트를 순서대로 이어붙여 반환
export async function recognizeRemoteImages(
  urls: string[],
  budgetMs: number
): Promise<string>
```

`recognizeRemoteImages` 동작:
1. `OCR_MAX_IMAGES`(기본 6개)까지만 처리 — 상세요강 이미지가 많은 공고도 앞쪽 이미지 위주로 처리(뒤로 갈수록 반복/꼬리말인 경우가 많음).
2. 이미지별로 순차 또는 소수 동시 호출로 `recognizeBuffer` 실행 — CLOVA API 호출 rate limit(요금제별 TPS 제한)을 넘지 않는 선에서 동시성 제한.
3. 이미지 fetch: `fetchHtml`과 동일한 User-Agent/timeout 패턴 재사용, `Content-Type: image/*` 아닌 응답은 스킵, 4MB 초과 응답은 스킵(업로드 라우트와 동일 기준).
   - 일부 CDN이 Referer 없는 요청을 막을 수 있어 `Referer: <원본 공고 URL>` 헤더 추가.
4. `budgetMs` 경과 시 새 이미지 처리 시작 안 하고 지금까지 인식된 텍스트만 리턴 (부분 결과라도 사용 — 전체 파싱을 실패시키지 않음).
5. 개별 이미지 fetch/OCR 실패는 조용히 스킵, 전체 흐름을 막지 않음 (best-effort) — CLOVA API 호출 실패(네트워크/인증/쿼터 초과 등)도 동일하게 해당 이미지만 스킵.

```
ponytail: 동시 호출 수 하드코딩(순차 또는 소수 고정) = 트래픽 늘면 처리 시간 늘어남.
동시 파싱 요청 늘어나면 CLOVA 요금제 TPS 한도 확인 후 동시성 조절.
```

## 6. API 변경

### 6.1 `POST /jobs/parse` (기존, 응답 스키마 변경 없음)
- 내부적으로 이미지형 공고면 자동 OCR 수행 후 필드/키워드가 더 채워진 상태로 응답. FE 변경 불필요.
- 응답 시간 증가 가능(아래 8절 참고) — FE 로딩 상태 문구는 그대로 유지해도 무방하나, 체감 지연이 커지면 "이미지 인식 중..." 문구 추가는 별도 FE 작업.

### 6.2 `POST /jobs/:id/images` (기존 라우트 확장)
`src/routes/jobs.routes.ts:109`
- 업로드 성공 후 buffer로 `recognizeBuffer` 실행, 결과를 `job_posting_images.ocr_text`에 저장.
- 응답에 `ocr_text` 필드 추가 (실패 시 `null`, 업로드 자체는 성공 처리).

### 6.3 `POST /jobs/:id/ocr-fill` (신규)
- Body: `{ confirm?: boolean }` (기본 `false`).
- `job_posting_images.ocr_text`를 모아 `raw_text`에 병합 → `FieldExtractor.extract`로 필드 후보값 계산.
- 충돌 필드가 있고 `confirm !== true`면 저장 없이 `200 { status: "confirm_required", conflicts: [{ field, current, ocr }] }` 반환 (4.3절).
- 충돌이 없거나 `confirm === true`면 `mergeLlmFields` 적용 → 키워드 재추출 → `job_postings` 업데이트 후 `200 { status: "applied", job: JobPosting }` 리턴.
- OCR 텍스트가 하나도 없으면 `400 { error: "no_ocr_text" }`.

## 7. DB 마이그레이션

`supabase/migrations/004_ocr_text.sql` (신규, 사용자 업로드 이미지용)

```sql
alter table job_posting_images
  add column if not exists ocr_text text;
```

원격 이미지 OCR 결과는 별도 컬럼 없이 `job_postings.raw_text`에 바로 합쳐지므로 스키마 변경 불필요. `devStore.ts`(로컬 dev DB)의 `job_posting_images` 목업 타입에 `ocr_text` 필드 추가.

## 8. 성능/운영 고려사항

| 항목 | 내용 |
|---|---|
| 추가 지연시간 | `POST /jobs/parse` 응답 시간에 `OCR_TIMEOUT_MS`(기본 8000ms)까지 추가될 수 있음. 텍스트형 공고(대다수)는 `detail_image_urls`가 비어있어 영향 없음. |
| 타임아웃 관계 | OCR 예산은 기존 `PARSE_TIMEOUT_MS`(파싱용, 기본 30000ms)와 별도 env(`OCR_TIMEOUT_MS`)로 관리 — 파싱 자체 타임아웃 로직을 건드리지 않기 위함. 프록시/로드밸런서 타임아웃이 짧다면(예: 30초) 합산 시간이 초과할 수 있어 배포 환경의 요청 타임아웃 설정 함께 확인 필요. |
| 외부 API 의존 | 서버 CPU를 쓰지 않는 대신 네트워크 왕복 + CLOVA 측 지연이 응답 시간에 그대로 반영됨. CLOVA 장애/네트워크 단절 시에도 개별 이미지 스킵으로 흡수되어 파싱 자체는 실패하지 않음(9절). |
| 비용 | 유료 API — 호출 1건당 과금. `OCR_MAX_IMAGES` 상한이 공고당 최대 호출 수를 사실상 캡핑해 비용 상한 역할도 겸함. 무료 크레딧으로 실사용 트래픽 기준 비용 먼저 검증 필요(12절). |
| 이미지 개수 상한 | `OCR_MAX_IMAGES`(기본 6) — 초과분은 OCR 안 하고 URL 나열만 유지(기존 동작과 동일하게 폴백). |

### 신규 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OCR_TIMEOUT_MS` | `8000` | 원격 이미지 OCR 총 시간 예산 |
| `OCR_MAX_IMAGES` | `6` | 공고 하나당 OCR 처리할 최대 이미지 수 |
| `CLOVA_OCR_SECRET_KEY` | (필수, 기본값 없음) | CLOVA OCR API 인증 시크릿 키 (`X-OCR-SECRET` 헤더) |
| `CLOVA_OCR_API_URL` | (필수, 기본값 없음) | NCP 콘솔에서 발급되는 앱별 Invoke URL |

## 9. 에러 처리

| 상황 | 처리 |
|---|---|
| 원격 이미지 fetch 실패/타임아웃/비이미지 응답 | 해당 이미지만 스킵, 나머지 계속 진행 |
| CLOVA OCR API 호출 실패(네트워크/인증/쿼터 초과 등) | 해당 이미지만 스킵, 나머지 계속 진행 (콘솔 warn으로 원인 구분 로깅) |
| OCR 전체 시간 예산 초과 | 지금까지 인식된 텍스트만 사용, 파싱 자체는 정상 진행(fail 아님) |
| 사용자 업로드 이미지 OCR 실패 | 업로드는 성공, `ocr_text: null`, 콘솔 warn |
| `/ocr-fill` 호출 시 OCR 텍스트 없음 | `400 no_ocr_text` |
| 충돌 필드 존재, `confirm` 미전달 | 저장하지 않고 `confirm_required` + 충돌 목록 반환 (에러 아님, 정상 분기) |
| 소유하지 않은 job | 기존 `getJob`의 404/403 처리 재사용 |

## 10. 테스트 계획

- `ocrService.recognizeBuffer`: 샘플 이미지(간단한 한글/영문 텍스트 스크린샷)로 인식 결과에 기대 키워드 포함되는지 확인하는 최소 단위 테스트.
- `ocrService.recognizeRemoteImages`: 이미지 URL 여러 개 중 일부가 실패해도 나머지 결과는 반환되는지, `budgetMs` 초과 시 조기 종료하는지 확인.
- `parseAndCreateJob` 통합 테스트: `detail_image_urls`가 있는 목업 응답 기준으로 `raw_text`에 OCR 섹션이 추가되고, `qualifications`/`preferences`가 채워지면 키워드 추출이 실행되는지 확인(4.2 게이트 조건 검증).
- `POST /jobs/:id/ocr-fill`: (1) 충돌 필드가 있을 때 `confirm` 없이 호출하면 저장 없이 `confirm_required`와 정확한 충돌 목록을 반환하는지, (2) `confirm: true`로 재호출하면 충돌 필드까지 덮어써지는지, (3) 충돌 없는 빈 필드는 최초 호출에서 팝업 없이 바로 채워지는지 확인.

## 11. 작업 순서

1. NCP 콘솔에서 CLOVA OCR(General) 앱 생성 후 Secret Key/Invoke URL 발급, `ocrService.ts` 작성(`recognizeBuffer`, API 클라이언트) + 최소 self-check.
2. `ParsedFields.detail_image_urls` 추가 (parser/index.ts, saraminDetail.ts, jobkoreaDetail.ts).
3. `ocrService.recognizeRemoteImages` 작성.
4. `jobService.parseAndCreateJob`에 원격 OCR 훅 추가 + 4.2 키워드 게이트 조건 변경.
5. 마이그레이션 004 작성 + `devStore.ts` 타입 반영.
6. `POST /jobs/:id/images`에 OCR 훅 추가 (업로드 이미지 OCR).
7. `applyOcrFill` 서비스 함수(충돌 탐지 + `confirm` 분기 포함) + `POST /jobs/:id/ocr-fill` 라우트.
8. README 환경변수 표에 `OCR_TIMEOUT_MS` / `OCR_MAX_IMAGES` / `CLOVA_OCR_SECRET_KEY` / `CLOVA_OCR_API_URL` 추가.
9. FE: 이미지형 공고 파싱 결과가 더 채워져 보이는지 확인, 업로드 후 `ocr_text` 표시 + "이미지로 필드 채우기" 버튼 연동 (별도 FE 작업, 이 문서는 BE 범위만).

## 12. 미결 사항

- 실제 Saramin/Jobkorea 상세요강 이미지 샘플로 OCR 정확도 먼저 확인 필요 — 스크린샷 폰트/배경이 다양하면 전처리(이진화 등) 필요할 수 있음.
- 이미지 CDN이 Referer 체크로 막을 경우 대응(User-Agent만으론 부족할 수 있음) — 실제 fetch 테스트로 확인.
- `OCR_TIMEOUT_MS` 기본값(8000ms)은 추정치 — 실측 후 조정.
- CLOVA OCR 무료 크레딧으로 실사용 트래픽 기준 호출당 비용/한도 먼저 검증 — 유료 전환 시점의 실제 비용 규모 확인 필요.
