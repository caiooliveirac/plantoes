// Limite de falhas de login em memória: 10 senhas erradas em 15 min, contadas
// por IP e por e-mail separadamente, bloqueiam aquele IP / aquele e-mail até a
// janela vencer. Em memória basta porque o web roda em um único processo PM2
// (ecosystem.config.cjs, app "plantoes", fork); se virar multi-instância, vai
// para tabela. Só falha conta — login certo não gasta tentativa e limpa a
// contagem do e-mail.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const failures = new Map<string, { count: number; windowStartedAt: number }>();

export const LOGIN_RATE_LIMIT_MESSAGE = "Muitas tentativas de login. Aguarde 15 minutos e tente de novo.";

/* Cloudflare na frente: cf-connecting-ip é o cliente; x-real-ip (nginx) é o
   fallback. x-forwarded-for não entra — o cliente pode forjá-lo e girar de
   "IP" a cada tentativa. Sem nenhum dos dois, não há chave de IP (o limite por
   e-mail continua): juntar todo mundo numa chave só travaria o login de todos. */
export function getLoginClientIp(headers: Headers) {
    return headers.get("cf-connecting-ip")?.trim() || headers.get("x-real-ip")?.trim() || null;
}

export function loginRateLimitKeys(ip: string | null, email: string) {
    const keys = [`email:${email.trim().toLowerCase()}`];
    if (ip) keys.push(`ip:${ip}`);
    return keys;
}

function currentCount(key: string, now: number) {
    const entry = failures.get(key);
    if (!entry) return 0;
    if (now - entry.windowStartedAt >= WINDOW_MS) {
        failures.delete(key);
        return 0;
    }
    return entry.count;
}

export function isLoginRateLimited(keys: string[], now = Date.now()) {
    return keys.some((key) => currentCount(key, now) >= MAX_FAILURES);
}

export function registerLoginFailure(keys: string[], now = Date.now()) {
    for (const key of keys) {
        const count = currentCount(key, now);
        if (count === 0) {
            failures.set(key, { count: 1, windowStartedAt: now });
        } else {
            failures.get(key)!.count = count + 1;
        }
    }
    if (failures.size > 10_000) {
        // Poda janelas velhas para o Map não crescer sem limite.
        for (const key of [...failures.keys()]) currentCount(key, now);
    }
}

export function clearLoginFailures(email: string) {
    failures.delete(`email:${email.trim().toLowerCase()}`);
}
