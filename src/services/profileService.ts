import { supabaseAdmin, isSupabaseConfigured } from "../db/supabase.js";
import {
  devDeleteAccount,
  devGetProfile,
  devUpdateProfile,
} from "../db/devStore.js";
import { AppError } from "../middleware/errorHandler.js";

export async function createProfile(
  userId: string,
  email: string,
  nickname: string
) {
  if (!isSupabaseConfigured()) {
    return devUpdateProfile(userId, { nickname });
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .insert({ id: userId, email, nickname })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError(409, "이미 사용 중인 이메일입니다.", "email_exists");
    }
    throw new AppError(500, error.message);
  }

  return data;
}

export async function getProfile(userId: string) {
  if (!isSupabaseConfigured()) {
    return devGetProfile(userId);
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw new AppError(404, "프로필을 찾을 수 없습니다.");
  }

  return data;
}

export async function updateProfile(
  userId: string,
  updates: {
    nickname?: string;
    avatar_url?: string;
    onboarding_completed_at?: string | null;
  }
) {
  if (!isSupabaseConfigured()) {
    return devUpdateProfile(userId, updates);
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .update(updates)
    .eq("id", userId)
    .select()
    .single();

  if (error) throw new AppError(500, error.message);
  return data;
}

export async function deleteAccount(userId: string) {
  if (!isSupabaseConfigured()) {
    devDeleteAccount(userId);
    return;
  }

  const { data: images } = await supabaseAdmin
    .from("job_posting_images")
    .select("storage_path")
    .eq("user_id", userId);

  const paths = (images ?? []).map((i) => i.storage_path);
  const profile = await getProfile(userId);
  if (profile.avatar_url) {
    const avatarPath = profile.avatar_url.split("/job-images/").pop();
    if (avatarPath) paths.push(avatarPath);
  }

  if (paths.length) {
    await supabaseAdmin.storage.from("job-images").remove(paths);
    await supabaseAdmin.storage.from("avatars").remove(paths);
  }

  await supabaseAdmin.from("job_posting_images").delete().eq("user_id", userId);
  await supabaseAdmin.from("job_postings").delete().eq("user_id", userId);
  await supabaseAdmin.from("analytics_events").delete().eq("user_id", userId);
  await supabaseAdmin.from("profiles").delete().eq("id", userId);

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) throw new AppError(500, error.message);
}

export async function uploadAvatar(
  userId: string,
  buffer: Buffer,
  mimeType: string
) {
  if (!isSupabaseConfigured()) {
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    await devUpdateProfile(userId, { avatar_url: dataUrl });
    return dataUrl;
  }

  const ext = mimeType === "image/png" ? "png" : "jpg";
  const path = `${userId}/avatar.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from("avatars")
    .upload(path, buffer, { upsert: true, contentType: mimeType });

  if (error) throw new AppError(500, error.message);

  const { data: urlData } = supabaseAdmin.storage.from("avatars").getPublicUrl(path);
  await updateProfile(userId, { avatar_url: urlData.publicUrl });
  return urlData.publicUrl;
}

export async function uploadJobImage(
  userId: string,
  jobId: string,
  buffer: Buffer,
  mimeType: string,
  filename: string
) {
  if (!isSupabaseConfigured()) {
    const path = `${userId}/${jobId}/${filename}`;
    const publicUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    return { path, publicUrl };
  }

  const ext = mimeType === "image/png" ? "png" : "jpg";
  const path = `${userId}/${jobId}/${filename}.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from("job-images")
    .upload(path, buffer, { upsert: false, contentType: mimeType });

  if (error) throw new AppError(500, error.message);

  const { data: urlData } = supabaseAdmin.storage.from("job-images").getPublicUrl(path);
  return { path, publicUrl: urlData.publicUrl };
}
