-- 수동 추가(원문 붙여넣기) 공고 지원.
-- 이 파일 안에서 'manual' 값을 사용하는 문장(백필 UPDATE 등)을 추가하지 말 것 —
-- 같은 트랜잭션에서 새로 추가한 enum 값을 바로 쓰면 Postgres가 거부한다
-- (unsafe use of new value of enum type).
ALTER TYPE platform_type ADD VALUE IF NOT EXISTS 'manual';

ALTER TABLE job_postings ALTER COLUMN source_url DROP NOT NULL;
