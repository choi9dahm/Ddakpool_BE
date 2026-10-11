import { supabaseAdmin, isSupabaseConfigured } from "../db/supabase.js";
import { devEnsureDefaultFolders, devGetProfile } from "../db/devStore.js";
import { AppError } from "../middleware/errorHandler.js";
import { createProfile, deleteAccount } from "./profileService.js";
import {
  ensureDefaultFolders,
  listFolders,
  type FolderRow,
} from "./folderService.js";

export const GUEST_NICKNAME = "게스트";

export type ClaimResult = "noop" | "migrated" | "discarded";

export async function ensureGuestProfile(userId: string, isAnonymous: boolean) {
  if (!isSupabaseConfigured()) {
    const profile = devGetProfile(userId);
    devEnsureDefaultFolders(userId);
    return profile;
  }

  if (!isAnonymous) {
    throw new AppError(403, "게스트 세션이 아닙니다.", "not_guest");
  }

  const { data: existing } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  const profile = existing ?? (await createProfile(userId, "", GUEST_NICKNAME));
  await ensureDefaultFolders(userId);
  return profile;
}

export async function claimGuestData(
  guestToken: string,
  targetUserId: string
): Promise<ClaimResult> {
  if (!isSupabaseConfigured()) return "noop";

  const { data, error } = await supabaseAdmin.auth.getUser(guestToken);
  if (error || !data.user) {
    throw new AppError(
      401,
      "게스트 세션을 확인할 수 없습니다.",
      "invalid_guest_token"
    );
  }

  const guest = data.user;
  // 익명 세션만 허용한다. 영구 계정 토큰을 넘겨 남의 데이터를 가져가는 것을 막는다.
  if (guest.is_anonymous !== true) {
    throw new AppError(403, "게스트 세션이 아닙니다.", "not_guest");
  }
  if (guest.id === targetUserId) return "noop";

  const { data: targetJobs, error: targetError } = await supabaseAdmin
    .from("job_postings")
    .select("id")
    .eq("user_id", targetUserId)
    .limit(1);
  if (targetError) throw new AppError(500, targetError.message);

  if (targetJobs?.length) {
    await deleteAccount(guest.id);
    return "discarded";
  }

  await migrateGuestRows(guest.id, targetUserId);
  await deleteAccount(guest.id);
  return "migrated";
}

async function migrateGuestRows(guestId: string, targetUserId: string) {
  const guestFolders = await listFolders(guestId);
  const targetFolders = await ensureDefaultFolders(targetUserId);
  // folders 는 UNIQUE (user_id, slot) 이므로 폴더 행을 옮기지 않고 slot으로 매핑한다.
  const targetIdBySlot = new Map(targetFolders.map((f) => [f.slot, f.id]));

  for (const folder of guestFolders) {
    if (targetIdBySlot.has(folder.slot)) continue;
    const { data: inserted, error } = await supabaseAdmin
      .from("folders")
      .insert({ user_id: targetUserId, name: folder.name, slot: folder.slot })
      .select()
      .single();
    if (error) throw new AppError(500, error.message);
    targetIdBySlot.set(folder.slot, (inserted as FolderRow).id);
  }

  for (const folder of guestFolders) {
    const { error } = await supabaseAdmin
      .from("job_postings")
      .update({
        user_id: targetUserId,
        folder_id: targetIdBySlot.get(folder.slot) ?? null,
      })
      .eq("user_id", guestId)
      .eq("folder_id", folder.id);
    if (error) throw new AppError(500, error.message);
  }

  const { error: uncategorizedError } = await supabaseAdmin
    .from("job_postings")
    .update({ user_id: targetUserId })
    .eq("user_id", guestId)
    .is("folder_id", null);
  if (uncategorizedError) throw new AppError(500, uncategorizedError.message);

  // storage_path 는 그대로 둔다. 게스트 id 프리픽스가 남지만 public URL은 유효하다.
  const { error: imageError } = await supabaseAdmin
    .from("job_posting_images")
    .update({ user_id: targetUserId })
    .eq("user_id", guestId);
  if (imageError) throw new AppError(500, imageError.message);
}
