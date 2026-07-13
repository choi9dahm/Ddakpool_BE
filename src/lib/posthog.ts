import { PostHog } from "posthog-node";

const apiKey = process.env.POSTHOG_API_KEY?.trim();
const host = process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

// API Key가 없으면 트래킹을 비활성화한다(로컬/미설정 환경 no-op).
const client: PostHog | null = apiKey ? new PostHog(apiKey, { host }) : null;

export function capturePostHog(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {}
) {
  if (!client) return;
  client.capture({ distinctId, event, properties });
}

export function identifyPostHog(
  distinctId: string,
  properties: Record<string, unknown> = {}
) {
  if (!client) return;
  client.identify({ distinctId, properties });
}

export async function shutdownPostHog() {
  if (!client) return;
  await client.shutdown();
}
