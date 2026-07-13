import { devListJobs } from "../db/devStore.js";
import { isSupabaseConfigured, supabaseAdmin } from "../db/supabase.js";
import { capturePostHog } from "../lib/posthog.js";

export type AnalyticsEventName =
  | "url_submitted"
  | "parse_result"
  | "tag_assigned"
  | "save_success";

export async function logEvent(
  userId: string | null,
  eventName: AnalyticsEventName,
  eventData: Record<string, unknown> = {}
) {
  // PostHog 서버 이벤트 전송(distinct id = 로그인 유저 id). Supabase 설정과 무관하게 동작.
  if (userId) {
    capturePostHog(userId, eventName, eventData);
  }

  if (!isSupabaseConfigured()) return;

  await supabaseAdmin.from("analytics_events").insert({
    user_id: userId,
    event_name: eventName,
    event_data: eventData,
  });
}

export async function getKpiSummary(userId: string) {
  if (!isSupabaseConfigured()) {
    const allJobs = devListJobs(userId, {});
    const tagged = allJobs.filter((j) => j.purpose_tag).length;
    return {
      parseSuccessRate: 0,
      totalParses: 0,
      saveSuccessCount: 0,
      tagAssignedEvents: 0,
      totalJobs: allJobs.length,
      taggedJobs: tagged,
      tagSettingRate: allJobs.length ? tagged / allJobs.length : 0,
    };
  }

  const { data: events } = await supabaseAdmin
    .from("analytics_events")
    .select("event_name, event_data")
    .eq("user_id", userId);

  const parseEvents =
    events?.filter((e) => e.event_name === "parse_result") ?? [];
  const totalParses = parseEvents.length;
  const successCount = parseEvents.filter(
    (e) =>
      (e.event_data as { result?: string })?.result === "success" ||
      (e.event_data as { result?: string })?.result === "partial"
  ).length;

  const saveSuccess = events?.filter((e) => e.event_name === "save_success").length ?? 0;
  const tagAssigned = events?.filter((e) => e.event_name === "tag_assigned").length ?? 0;

  const { count: jobCount } = await supabaseAdmin
    .from("job_postings")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  const taggedJobs = await supabaseAdmin
    .from("job_postings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .not("purpose_tag", "is", null);

  return {
    parseSuccessRate: totalParses > 0 ? successCount / totalParses : 0,
    totalParses,
    saveSuccessCount: saveSuccess,
    tagAssignedEvents: tagAssigned,
    totalJobs: jobCount ?? 0,
    taggedJobs: taggedJobs.count ?? 0,
    tagSettingRate: jobCount ? (taggedJobs.count ?? 0) / jobCount : 0,
  };
}
