function parseAllowedOrigins(): string[] {
  const raw =
    process.env.CORS_ORIGIN ??
    process.env.CORS_ORIGINS ??
    "http://localhost:3000";

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isVercelOrigin(origin: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes(origin)) return true;
  if (process.env.CORS_ALLOW_VERCEL === "true" && isVercelOrigin(origin)) {
    return true;
  }
  return false;
}

export function getCorsOptions() {
  const allowedOrigins = parseAllowedOrigins();

  return {
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, allow: boolean | string) => void
    ) => {
      if (!origin || isOriginAllowed(origin, allowedOrigins)) {
        cb(null, origin ?? true);
        return;
      }

      cb(new Error(`Origin not allowed by CORS: ${origin}`), false);
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  };
}
