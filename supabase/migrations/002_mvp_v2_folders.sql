-- MVP v2: folders, folder_id, structured keywords, deadline_status

CREATE TYPE deadline_status_type AS ENUM ('always_open', 'closed');

CREATE TABLE folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 6),
  slot INT NOT NULL CHECK (slot BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, slot)
);

CREATE INDEX idx_folders_user_id ON folders(user_id);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deadline_status deadline_status_type;

CREATE INDEX idx_job_postings_folder_id ON job_postings(folder_id);

-- Backfill folders from existing purpose_tag values per user
INSERT INTO folders (user_id, name, slot)
SELECT DISTINCT jp.user_id, mapping.name, mapping.slot
FROM job_postings jp
CROSS JOIN (
  VALUES
    ('지원예정', 1),
    ('직무분석', 2),
    ('관심기업', 3)
) AS mapping(name, slot)
WHERE jp.purpose_tag::text = mapping.name
ON CONFLICT (user_id, slot) DO NOTHING;

-- Users with jobs but no folders yet: seed default 3 folders
INSERT INTO folders (user_id, name, slot)
SELECT DISTINCT jp.user_id, d.name, d.slot
FROM job_postings jp
CROSS JOIN (
  VALUES
    ('지원예정', 1),
    ('직무분석', 2),
    ('관심기업', 3)
) AS d(name, slot)
WHERE NOT EXISTS (
  SELECT 1 FROM folders f WHERE f.user_id = jp.user_id
)
ON CONFLICT (user_id, slot) DO NOTHING;

-- Map purpose_tag to folder_id
UPDATE job_postings jp
SET folder_id = f.id
FROM folders f
WHERE f.user_id = jp.user_id
  AND f.name = jp.purpose_tag::text
  AND jp.purpose_tag::text IN ('지원예정', '직무분석', '관심기업');

-- 기타 / null purpose_tag → folder_id stays null (미분류)

-- Convert competency_keywords from string[] to structured objects
UPDATE job_postings
SET competency_keywords = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'text', elem,
        'source_section', '기타',
        'order', ord - 1,
        'source', 'llm'
      )
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(competency_keywords) = 'array'
        AND jsonb_array_length(competency_keywords) > 0
        AND jsonb_typeof(competency_keywords->0) = 'string'
      THEN competency_keywords
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_typeof(competency_keywords) = 'array'
  AND (
    jsonb_array_length(competency_keywords) = 0
    OR jsonb_typeof(competency_keywords->0) = 'string'
  );

DROP INDEX IF EXISTS idx_job_postings_purpose_tag;
ALTER TABLE job_postings DROP COLUMN IF EXISTS purpose_tag;
DROP TYPE IF EXISTS purpose_tag;

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY folders_all ON folders FOR ALL USING (auth.uid() = user_id);

CREATE TRIGGER folders_updated_at BEFORE UPDATE ON folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
