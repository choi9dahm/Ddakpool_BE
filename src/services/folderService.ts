import { supabaseAdmin, isSupabaseConfigured } from "../db/supabase.js";
import {
  devEnsureDefaultFolders,
  devGetFolders,
  devSaveFolders,
} from "../db/devStore.js";
import { AppError } from "../middleware/errorHandler.js";

export const FOLDER_SLOT_COLORS: Record<number, { bg: string; text: string }> = {
  1: { bg: "#63CCCA", text: "#18181B" },
  2: { bg: "#32A287", text: "#FFFFFF" },
  3: { bg: "#82D173", text: "#18181B" },
  4: { bg: "#94E8B4", text: "#18181B" },
  5: { bg: "#397367", text: "#FFFFFF" },
};

export const DEFAULT_FOLDER_SEEDS = [
  { name: "지원예정", slot: 1 },
  { name: "직무분석", slot: 2 },
  { name: "관심기업", slot: 3 },
] as const;

export interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  slot: number;
  created_at: string;
  updated_at: string;
}

export interface FolderInput {
  id?: string;
  name: string;
  slot: number;
}

function validateFolderInputs(folders: FolderInput[]) {
  if (folders.length > 5) {
    throw new AppError(400, "폴더는 최대 5개까지 만들 수 있어요.", "max_folders");
  }

  const slots = new Set<number>();
  for (const folder of folders) {
    if (folder.slot < 1 || folder.slot > 5) {
      throw new AppError(400, "폴더 슬롯이 올바르지 않아요.", "invalid_slot");
    }
    if (slots.has(folder.slot)) {
      throw new AppError(400, "폴더 슬롯이 중복되었어요.", "duplicate_slot");
    }
    slots.add(folder.slot);

    const name = folder.name.trim();
    if (name.length < 1 || name.length > 6) {
      throw new AppError(400, "폴더 이름은 1~6자여야 해요.", "invalid_name");
    }
  }
}

export async function ensureDefaultFolders(userId: string): Promise<FolderRow[]> {
  if (!isSupabaseConfigured()) {
    return devEnsureDefaultFolders(userId);
  }

  const existing = await listFolders(userId);
  // 기본 폴더도 삭제 가능(JD-FOL-M04). 이미 폴더가 있으면 재시드하지 않는다.
  // 시드는 가입 직후·폴더가 0개인 최초 상태만.
  if (existing.length > 0) return existing;

  const { error } = await supabaseAdmin.from("folders").insert(
    DEFAULT_FOLDER_SEEDS.map((seed) => ({
      user_id: userId,
      name: seed.name,
      slot: seed.slot,
    }))
  );

  if (error) {
    throw new AppError(500, "기본 폴더 생성에 실패했습니다.", "folder_seed_failed");
  }

  return listFolders(userId);
}

export async function listFolders(userId: string): Promise<FolderRow[]> {
  if (!isSupabaseConfigured()) {
    return devGetFolders(userId);
  }

  const { data, error } = await supabaseAdmin
    .from("folders")
    .select("*")
    .eq("user_id", userId)
    .order("slot", { ascending: true });

  if (error) throw new AppError(500, error.message);
  return (data ?? []) as FolderRow[];
}

export async function getFoldersOrSeed(userId: string): Promise<FolderRow[]> {
  return ensureDefaultFolders(userId);
}

export async function saveFolders(
  userId: string,
  folders: FolderInput[],
  deletedIds: string[] = []
): Promise<FolderRow[]> {
  validateFolderInputs(folders);

  if (!isSupabaseConfigured()) {
    return devSaveFolders(userId, folders, deletedIds);
  }

  const current = await listFolders(userId);
  const currentIds = new Set(current.map((f) => f.id));
  const incomingIds = new Set(folders.map((f) => f.id).filter(Boolean) as string[]);

  for (const id of deletedIds) {
    if (!currentIds.has(id)) continue;
    await supabaseAdmin
      .from("job_postings")
      .update({ folder_id: null })
      .eq("user_id", userId)
      .eq("folder_id", id);

    const { error } = await supabaseAdmin
      .from("folders")
      .delete()
      .eq("user_id", userId)
      .eq("id", id);
    if (error) throw new AppError(500, error.message);
  }

  const results: FolderRow[] = [];

  for (const folder of folders) {
    const payload = {
      user_id: userId,
      name: folder.name.trim(),
      slot: folder.slot,
    };

    if (folder.id && currentIds.has(folder.id)) {
      const { data, error } = await supabaseAdmin
        .from("folders")
        .update(payload)
        .eq("user_id", userId)
        .eq("id", folder.id)
        .select()
        .single();
      if (error) throw new AppError(500, error.message);
      results.push(data as FolderRow);
      continue;
    }

    if (folder.id && !currentIds.has(folder.id)) {
      throw new AppError(404, "폴더를 찾을 수 없습니다.", "folder_not_found");
    }

    const { data, error } = await supabaseAdmin
      .from("folders")
      .insert(payload)
      .select()
      .single();
    if (error) throw new AppError(500, error.message);
    results.push(data as FolderRow);
  }

  for (const existing of current) {
    if (!incomingIds.has(existing.id) && !deletedIds.includes(existing.id)) {
      await supabaseAdmin
        .from("job_postings")
        .update({ folder_id: null })
        .eq("user_id", userId)
        .eq("folder_id", existing.id);

      const { error } = await supabaseAdmin
        .from("folders")
        .delete()
        .eq("user_id", userId)
        .eq("id", existing.id);
      if (error) throw new AppError(500, error.message);
    }
  }

  return results.sort((a, b) => a.slot - b.slot);
}

export async function validateFolderId(
  userId: string,
  folderId: string | null | undefined
): Promise<string | null> {
  if (folderId === null || folderId === undefined) return null;
  const folders = await getFoldersOrSeed(userId);
  const found = folders.find((f) => f.id === folderId);
  if (!found) {
    throw new AppError(400, "유효하지 않은 폴더입니다.", "invalid_folder");
  }
  return folderId;
}
