function normalizeUrl(value: string) {
  const trimmed = value.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/$/, "");
}

function isLocalUrl(value: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(value);
}

function isNgrokUrl(value: string) {
  return /\.ngrok(-free)?\.app$/i.test(new URL(value).hostname);
}

function firstConfigured(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim();
}

export function resolvePublicShipBrainUrl(request: Request, options: { requirePublicForLocal?: boolean } = {}) {
  const explicit = firstConfigured(process.env.SHIPBRAIN_API_URL, process.env.NEXT_PUBLIC_SHIPBRAIN_API_URL);
  const hosted = firstConfigured(
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL
  );

  if (process.env.VERCEL_ENV === "production") {
    const hostedUrl = hosted ? normalizeUrl(hosted) : "";
    if (hostedUrl && !isLocalUrl(hostedUrl) && !isNgrokUrl(hostedUrl)) {
      return hostedUrl;
    }
  }

  if (explicit) return normalizeUrl(explicit);
  if (hosted) return normalizeUrl(hosted);

  const origin = new URL(request.url).origin.replace(/\/$/, "");
  if (options.requirePublicForLocal && isLocalUrl(origin)) {
    throw new Error(
      "Set SHIPBRAIN_API_URL to a public HTTPS ShipBrain callback URL. For local E2E testing this can be ngrok; in production use your Vercel-hosted ShipBrain URL."
    );
  }
  return origin;
}
