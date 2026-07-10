import { isSupabaseConfigured, supabaseAdmin } from "../db/supabase.js";

type JobImage = { id: string; storage_path: string; sort_order: number };

export async function resolveJobImageUrl(storagePath: string): Promise<string> {
  if (!storagePath) return "";
  if (storagePath.startsWith("data:") || storagePath.startsWith("http")) {
    return storagePath;
  }

  if (!isSupabaseConfigured()) return "";

  const { data, error } = await supabaseAdmin.storage
    .from("job-images")
    .createSignedUrl(storagePath, 60 * 60);

  if (!error && data?.signedUrl) {
    return data.signedUrl;
  }

  const { data: urlData } = supabaseAdmin.storage
    .from("job-images")
    .getPublicUrl(storagePath);
  return urlData.publicUrl;
}

export async function resolveJobImage(image: JobImage): Promise<JobImage> {
  return {
    ...image,
    storage_path: await resolveJobImageUrl(image.storage_path),
  };
}

export async function resolveJobImages<T extends { job_posting_images?: JobImage[] }>(
  job: T
): Promise<T> {
  if (!job.job_posting_images?.length) return job;

  const job_posting_images = await Promise.all(
    job.job_posting_images.map(resolveJobImage)
  );

  return { ...job, job_posting_images };
}

export async function resolveJobsImages<T extends { job_posting_images?: JobImage[] }>(
  jobs: T[]
): Promise<T[]> {
  return Promise.all(jobs.map(resolveJobImages));
}
