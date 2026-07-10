import { randomUUID } from "node:crypto";
import type { JobPostingRow } from "../services/jobService.js";

export const DEV_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEV_AUTH_TOKEN = "dev-local-token";

interface DevProfile {
  id: string;
  email: string;
  nickname: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

const profiles = new Map<string, DevProfile>();
const jobs = new Map<string, JobPostingRow>();

function now() {
  return new Date().toISOString();
}

function ensureProfile(userId: string): DevProfile {
  let profile = profiles.get(userId);
  if (!profile) {
    profile = {
      id: userId,
      email: "dev@local.test",
      nickname: "개발자",
      avatar_url: null,
      created_at: now(),
      updated_at: now(),
    };
    profiles.set(userId, profile);
  }
  return profile;
}

export function devGetProfile(userId: string) {
  return ensureProfile(userId);
}

export function devUpdateProfile(
  userId: string,
  updates: { nickname?: string; avatar_url?: string }
) {
  const profile = ensureProfile(userId);
  const updated = {
    ...profile,
    ...updates,
    updated_at: now(),
  };
  profiles.set(userId, updated);
  return updated;
}

export function devDeleteAccount(userId: string) {
  profiles.delete(userId);
  for (const [id, job] of jobs) {
    if (job.user_id === userId) jobs.delete(id);
  }
}

export function devCreateJob(
  userId: string,
  payload: Omit<JobPostingRow, "id" | "user_id" | "saved_at" | "updated_at">
) {
  const id = randomUUID();
  const timestamp = now();
  const job: JobPostingRow = {
    id,
    user_id: userId,
    saved_at: timestamp,
    updated_at: timestamp,
    job_posting_images: [],
    ...payload,
  };
  jobs.set(id, job);
  return job;
}

export function devListJobs(
  userId: string,
  options: {
    tag?: string;
    keywords?: string[];
    excludeExpired?: boolean;
  }
) {
  let result = [...jobs.values()].filter((j) => j.user_id === userId);

  if (options.tag) {
    result = result.filter((j) => j.purpose_tag === options.tag);
  }

  if (options.excludeExpired) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    result = result.filter((j) => {
      if (!j.deadline_date) return true;
      return new Date(j.deadline_date) >= today;
    });
  }

  if (options.keywords?.length) {
    result = result.filter((j) =>
      options.keywords!.some((k) => (j.competency_keywords ?? []).includes(k))
    );
  }

  return result;
}

export function devGetJob(userId: string, jobId: string) {
  const job = jobs.get(jobId);
  if (!job || job.user_id !== userId) return null;
  return job;
}

export function devUpdateJob(
  userId: string,
  jobId: string,
  payload: Partial<JobPostingRow>
) {
  const job = devGetJob(userId, jobId);
  if (!job) return null;
  const updated = { ...job, ...payload, updated_at: now() };
  jobs.set(jobId, updated);
  return updated;
}

export function devDeleteJob(userId: string, jobId: string) {
  const job = devGetJob(userId, jobId);
  if (!job) return false;
  jobs.delete(jobId);
  return true;
}

export function devGetAllKeywords(userId: string) {
  const set = new Set<string>();
  for (const job of jobs.values()) {
    if (job.user_id !== userId) continue;
    for (const kw of job.competency_keywords ?? []) set.add(kw);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ko"));
}

export function devAddJobImage(
  userId: string,
  jobId: string,
  storagePath: string,
  sortOrder: number
) {
  const job = devGetJob(userId, jobId);
  if (!job) return null;
  const images = job.job_posting_images ?? [];
  if (images.length >= 5) return null;
  const image = {
    id: randomUUID(),
    storage_path: storagePath,
    sort_order: sortOrder,
  };
  job.job_posting_images = [...images, image];
  job.updated_at = now();
  jobs.set(jobId, job);
  return image;
}

export function devDeleteJobImage(
  userId: string,
  jobId: string,
  imageId: string
) {
  const job = devGetJob(userId, jobId);
  if (!job) return false;
  job.job_posting_images = (job.job_posting_images ?? []).filter(
    (img) => img.id !== imageId
  );
  job.updated_at = now();
  jobs.set(jobId, job);
  return true;
}
