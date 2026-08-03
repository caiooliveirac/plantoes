// ponytail: rate limit em memória por IP (10 tentativas/15min) — suficiente para
// um único processo PM2; migrar para tabela se o app virar multi-instância.
const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 10;

const hits = new Map<string, { count: number; windowStartedAt: number }>();

export function isSignupRateLimited(ip: string, now = Date.now()) {
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStartedAt >= WINDOW_MS) {
        hits.set(ip, { count: 1, windowStartedAt: now });
        return false;
    }
    entry.count += 1;
    if (hits.size > 10_000) {
        // Poda janelas velhas para o Map não crescer sem limite.
        for (const [key, value] of hits) {
            if (now - value.windowStartedAt >= WINDOW_MS) {
                hits.delete(key);
            }
        }
    }
    return entry.count > LIMIT;
}

export function getRequestIp(headers: Headers) {
    return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
