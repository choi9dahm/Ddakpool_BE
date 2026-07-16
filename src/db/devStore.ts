import { randomUUID } from "node:crypto";
import type { JobPostingRow } from "../services/jobService.js";
import type { FolderRow } from "../services/folderService.js";
import { DEFAULT_FOLDER_SEEDS } from "../services/folderService.js";

export const DEV_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEV_AUTH_TOKEN = "dev-local-token";

interface DevProfile {
  id: string;
  email: string;
  nickname: string;
  avatar_url: string | null;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const profiles = new Map<string, DevProfile>();
const jobs = new Map<string, JobPostingRow>();
const folders = new Map<string, FolderRow>();

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
      onboarding_completed_at: null,
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
  updates: {
    nickname?: string;
    avatar_url?: string;
    onboarding_completed_at?: string | null;
  }
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
  for (const [id, folder] of folders) {
    if (folder.user_id === userId) folders.delete(id);
  }
}

function userFolders(userId: string) {
  return [...folders.values()]
    .filter((f) => f.user_id === userId)
    .sort((a, b) => a.slot - b.slot);
}

export function devEnsureDefaultFolders(userId: string): FolderRow[] {
  const existing = userFolders(userId);
  const usedSlots = new Set(existing.map((f) => f.slot));

  for (const seed of DEFAULT_FOLDER_SEEDS) {
    if (usedSlots.has(seed.slot)) continue;
    const id = randomUUID();
    const timestamp = now();
    folders.set(id, {
      id,
      user_id: userId,
      name: seed.name,
      slot: seed.slot,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  return userFolders(userId);
}

export function devGetFolders(userId: string) {
  return userFolders(userId);
}

export function devSaveFolders(
  userId: string,
  inputs: { id?: string; name: string; slot: number }[],
  deletedIds: string[] = []
) {
  for (const id of deletedIds) {
    const folder = folders.get(id);
    if (!folder || folder.user_id !== userId) continue;
    for (const job of jobs.values()) {
      if (job.user_id === userId && job.folder_id === id) {
        job.folder_id = null;
        job.updated_at = now();
        jobs.set(job.id, job);
      }
    }
    folders.delete(id);
  }

  const keptIds = new Set<string>();
  const result: FolderRow[] = [];

  for (const input of inputs) {
    const timestamp = now();
    if (input.id && folders.has(input.id)) {
      const existing = folders.get(input.id)!;
      if (existing.user_id !== userId) continue;
      const updated: FolderRow = {
        ...existing,
        name: input.name.trim(),
        slot: input.slot,
        updated_at: timestamp,
      };
      folders.set(input.id, updated);
      keptIds.add(input.id);
      result.push(updated);
      continue;
    }

    const id = randomUUID();
    const folder: FolderRow = {
      id,
      user_id: userId,
      name: input.name.trim(),
      slot: input.slot,
      created_at: timestamp,
      updated_at: timestamp,
    };
    folders.set(id, folder);
    keptIds.add(id);
    result.push(folder);
  }

  for (const folder of userFolders(userId)) {
    if (!keptIds.has(folder.id) && !deletedIds.includes(folder.id)) {
      for (const job of jobs.values()) {
        if (job.user_id === userId && job.folder_id === folder.id) {
          job.folder_id = null;
          job.updated_at = now();
          jobs.set(job.id, job);
        }
      }
      folders.delete(folder.id);
    }
  }

  return result.sort((a, b) => a.slot - b.slot);
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
    folderId?: string | null;
    uncategorized?: boolean;
    keywords?: string[];
    excludeExpired?: boolean;
  }
) {
  let result = [...jobs.values()].filter((j) => j.user_id === userId);

  if (options.uncategorized) {
    result = result.filter((j) => !j.folder_id);
  } else if (options.folderId) {
    result = result.filter((j) => j.folder_id === options.folderId);
  }

  if (options.excludeExpired) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    result = result.filter((j) => {
      if (j.deadline_status === "closed") return false;
      if (j.deadline_status === "always_open") return true;
      if (!j.deadline_date) return true;
      return new Date(j.deadline_date) >= today;
    });
  }

  if (options.keywords?.length) {
    result = result.filter((j) => {
      const texts = (j.competency_keywords ?? []).map((k) => k.text);
      return options.keywords!.some((k) => texts.includes(k));
    });
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
    for (const kw of job.competency_keywords ?? []) set.add(kw.text);
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
