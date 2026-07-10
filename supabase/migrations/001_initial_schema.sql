-- Ddakpool initial schema

CREATE TYPE purpose_tag AS ENUM ('지원예정', '직무분석', '관심기업', '기타');
CREATE TYPE parsing_status AS ENUM ('success', 'partial', 'fail');
CREATE TYPE platform_type AS ENUM ('saramin', 'jobkorea');

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  nickname TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE job_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  platform platform_type NOT NULL,
  parsing_status parsing_status NOT NULL DEFAULT 'fail',
  parse_failure_reason TEXT,
  purpose_tag purpose_tag,
  company_name TEXT DEFAULT '',
  job_title TEXT DEFAULT '',
  recruitment_field TEXT DEFAULT '',
  job_description TEXT DEFAULT '',
  qualifications TEXT DEFAULT '',
  preferences TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  deadline_raw TEXT DEFAULT '',
  deadline_date DATE,
  required_documents TEXT DEFAULT '',
  application_method TEXT DEFAULT '',
  raw_text TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  competency_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE job_posting_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_postings_user_id ON job_postings(user_id);
CREATE INDEX idx_job_postings_purpose_tag ON job_postings(purpose_tag);
CREATE INDEX idx_job_postings_saved_at ON job_postings(saved_at DESC);
CREATE INDEX idx_job_postings_deadline_date ON job_postings(deadline_date);
CREATE INDEX idx_analytics_events_name ON analytics_events(event_name);
CREATE INDEX idx_analytics_events_user_id ON analytics_events(user_id);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_posting_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY profiles_update ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY profiles_insert ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY profiles_delete ON profiles FOR DELETE USING (auth.uid() = id);

CREATE POLICY job_postings_all ON job_postings FOR ALL USING (auth.uid() = user_id);

CREATE POLICY job_posting_images_all ON job_posting_images FOR ALL USING (auth.uid() = user_id);

CREATE POLICY analytics_events_select ON analytics_events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY analytics_events_insert ON analytics_events FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Storage buckets (run in Supabase dashboard or via API):
-- avatars: public read, authenticated write own folder
-- job-images: authenticated read/write own folder

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER job_postings_updated_at BEFORE UPDATE ON job_postings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
