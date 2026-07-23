-- MVP v2.1: image-based parse flag + per-user unique source URL
-- 기존 중복 (user_id, source_url) 이 있으면 unique index 생성 전에 정리한다.
-- 동일 URL 중 가장 먼저 저장된 행만 남기고 나머지는 삭제한다.
-- job_posting_images 는 ON DELETE CASCADE 로 함께 정리된다.

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS is_image_based boolean NOT NULL DEFAULT false;

DELETE FROM job_postings jp
WHERE jp.id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, source_url
        ORDER BY saved_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM job_postings
  ) ranked
  WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS job_postings_user_source_url_uidx
  ON job_postings (user_id, source_url);
