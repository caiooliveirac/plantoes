import { createHmac, randomInt } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { doctorPaymentAccess, doctors, telegramPaymentAccessAttempts } from "@/db/schema";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Cooldown anti-força-bruta por conta de Telegram.
export const ATTEMPT_LIMIT = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const ATTEMPT_LOCK_MS = 60 * 60 * 1000;

export interface AttemptRecord {
    failedCount: number;
    windowStartedAt: Date | null;
    lockedUntil: Date | null;
}

// Lógica pura: dado o estado anterior e "agora", calcula o próximo estado após uma
// tentativa errada. Reinicia a contagem quando a janela expira; trava ao atingir o
// limite. Extraída para ser testável sem banco.
export function computeNextAttempt(prev: { failedCount: number; windowStartedAt: Date | null } | null, now: Date): AttemptRecord {
    const windowOpen = prev?.windowStartedAt
        && (now.getTime() - prev.windowStartedAt.getTime()) < ATTEMPT_WINDOW_MS;
    const failedCount = (windowOpen ? prev!.failedCount : 0) + 1;
    const windowStartedAt = windowOpen ? prev!.windowStartedAt! : now;
    const lockedUntil = failedCount >= ATTEMPT_LIMIT ? new Date(now.getTime() + ATTEMPT_LOCK_MS) : null;
    return { failedCount, windowStartedAt, lockedUntil };
}

export function isAttemptLocked(lockedUntil: Date | null | undefined, now: Date) {
    return Boolean(lockedUntil && lockedUntil.getTime() > now.getTime());
}

// Listas curadas: sem acento e sem caracteres ambíguos, fáceis de ditar no telefone.
const CODENAME_ADJECTIVES = [
    "agil", "azul", "bravo", "calmo", "claro", "denso", "doce", "firme",
    "forte", "frio", "guapo", "jade", "leve", "livre", "lucido", "macio",
    "nobre", "novo", "puro", "rapido", "raro", "sabio", "sereno", "vivo",
] as const;

const CODENAME_NOUNS = [
    "falcao", "tigre", "lobo", "aguia", "puma", "garca", "corvo", "raposa",
    "onca", "gaviao", "tucano", "javali", "lince", "bisao", "condor", "veado",
    "tatu", "quati", "sabia", "urubu", "pelicano", "cervo", "lontra", "suricato",
] as const;

function getPepper() {
    const secret = process.env.AUTH_SECRET?.trim();
    if (!secret) {
        throw new Error("AUTH_SECRET is required for payment-access codenames.");
    }
    return secret;
}

// Normaliza para casar variações de digitação: minúsculas, sem acento, espaços/
// separadores viram hífen único, remove o resto.
export function normalizeCodename(value: string) {
    return value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function hashCodename(code: string) {
    return createHmac("sha256", getPepper()).update(normalizeCodename(code)).digest("hex");
}

function pick<T>(items: readonly T[]) {
    return items[randomInt(items.length)];
}

// Ex.: "falcao-jade-734". ~24 bits de entropia; combinado com o cooldown, resistente
// a adivinhação.
export function generateCodename() {
    const number = String(randomInt(100, 1000));
    return `${pick(CODENAME_NOUNS)}-${pick(CODENAME_ADJECTIVES)}-${number}`;
}

// Gera (ou regenera = reset) o codinome de um médico e devolve o valor em claro para
// o admin repassar. Em colisão improvável do hash, tenta de novo algumas vezes.
export async function upsertDoctorCodename(doctorId: string) {
    const db = getDb();
    for (let attempt = 0; attempt < 5; attempt++) {
        const codename = generateCodename();
        const codenameHmac = hashCodename(codename);
        try {
            await db.insert(doctorPaymentAccess)
                .values({ doctorId, codenameHmac, codename })
                .onConflictDoUpdate({
                    target: doctorPaymentAccess.doctorId,
                    set: { codenameHmac, codename, updatedAt: new Date() },
                });
            return codename;
        } catch (error) {
            // Colisão no índice único de codename_hmac → tenta outro valor.
            if (attempt === 4) {
                throw error;
            }
        }
    }
    throw new Error("could not generate a unique codename");
}

// Reset em massa: gera um codinome novo para cada médico ativo (invalida o anterior)
// e devolve a lista para entregar. Usado pelo comando admin /pagamento resetar-todos.
export async function resetAllDoctorCodenames(): Promise<Array<{ fullName: string; codename: string }>> {
    const db = getDb();
    const rows = await db
        .select({ id: doctors.id, fullName: doctors.fullName })
        .from(doctors)
        .where(eq(doctors.isActive, true))
        .orderBy(asc(doctors.normalizedName));

    const out: Array<{ fullName: string; codename: string }> = [];
    for (const row of rows) {
        const codename = await upsertDoctorCodename(row.id);
        out.push({ fullName: row.fullName, codename });
    }
    return out;
}

export async function resolveDoctorIdByCodename(code: string): Promise<string | null> {
    const normalized = normalizeCodename(code);
    if (!normalized) {
        return null;
    }
    const db = getDb();
    const [row] = await db
        .select({ doctorId: doctorPaymentAccess.doctorId })
        .from(doctorPaymentAccess)
        .where(eq(doctorPaymentAccess.codenameHmac, hashCodename(normalized)))
        .limit(1);
    return row?.doctorId ?? null;
}

// Reseta o codinome de um médico e devolve nome + novo codinome + o anterior em claro
// (se conhecido), para uma resposta verbosa.
export async function resetDoctorCodename(doctorId: string): Promise<{ fullName: string; codename: string; previous: string | null }> {
    const db = getDb();
    const [doctor] = await db
        .select({ fullName: doctors.fullName })
        .from(doctors)
        .where(eq(doctors.id, doctorId))
        .limit(1);
    const [existing] = await db
        .select({ codename: doctorPaymentAccess.codename })
        .from(doctorPaymentAccess)
        .where(eq(doctorPaymentAccess.doctorId, doctorId))
        .limit(1);
    const codename = await upsertDoctorCodename(doctorId);
    return { fullName: doctor?.fullName ?? "médico", codename, previous: existing?.codename ?? null };
}

// Lista todos os médicos ativos com o codinome em claro conhecido (null se a linha
// ainda é só-hash, ou se nunca teve codinome).
export async function listDoctorCodenames(): Promise<Array<{ fullName: string; codename: string | null }>> {
    const db = getDb();
    const rows = await db
        .select({ fullName: doctors.fullName, codename: doctorPaymentAccess.codename })
        .from(doctors)
        .leftJoin(doctorPaymentAccess, eq(doctorPaymentAccess.doctorId, doctors.id))
        .where(eq(doctors.isActive, true))
        .orderBy(asc(doctors.normalizedName));
    return rows.map((r) => ({ fullName: r.fullName, codename: r.codename ?? null }));
}

export interface AttemptLockState {
    locked: boolean;
    lockedUntil: Date | null;
}

export async function checkAttemptLock(telegramUserId: string, now = new Date()): Promise<AttemptLockState> {
    const db = getDb();
    const [row] = await db
        .select({ lockedUntil: telegramPaymentAccessAttempts.lockedUntil })
        .from(telegramPaymentAccessAttempts)
        .where(eq(telegramPaymentAccessAttempts.telegramUserId, telegramUserId))
        .limit(1);
    if (isAttemptLocked(row?.lockedUntil, now)) {
        return { locked: true, lockedUntil: row!.lockedUntil };
    }
    return { locked: false, lockedUntil: null };
}

// Registra uma tentativa errada; trava ao atingir o limite dentro da janela.
export async function registerFailedAttempt(telegramUserId: string, now = new Date()): Promise<AttemptLockState> {
    const db = getDb();
    const [existing] = await db
        .select({
            failedCount: telegramPaymentAccessAttempts.failedCount,
            windowStartedAt: telegramPaymentAccessAttempts.windowStartedAt,
        })
        .from(telegramPaymentAccessAttempts)
        .where(eq(telegramPaymentAccessAttempts.telegramUserId, telegramUserId))
        .limit(1);

    const { failedCount, windowStartedAt, lockedUntil } = computeNextAttempt(existing ?? null, now);

    await db.insert(telegramPaymentAccessAttempts)
        .values({ telegramUserId, failedCount, windowStartedAt, lockedUntil, updatedAt: now })
        .onConflictDoUpdate({
            target: telegramPaymentAccessAttempts.telegramUserId,
            set: { failedCount, windowStartedAt, lockedUntil, updatedAt: now },
        });

    return { locked: Boolean(lockedUntil), lockedUntil };
}

export async function clearAttempts(telegramUserId: string) {
    const db = getDb();
    await db.delete(telegramPaymentAccessAttempts)
        .where(eq(telegramPaymentAccessAttempts.telegramUserId, telegramUserId));
}

export function normalizeCompanyName(value: string) {
    return value.trim().replace(/\s+/g, " ");
}

export function normalizeCnpj(value: string) {
    const digits = value.replace(/\D/g, "");
    if (digits.length !== 14) {
        return null;
    }
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12, 14)}`;
}

export function isLikelyValidCnpj(value: string) {
    const digits = value.replace(/\D/g, "");
    if (digits.length !== 14) {
        return false;
    }
    if (/^(\d)\1{13}$/.test(digits)) {
        return false;
    }
    return true;
}

/**
 * Grava a sugestão de razão social/CNPJ importada da planilha oficial (sem
 * confirmar nada) — usada pelo bot para oferecer "Está certo?" em vez de pedir
 * para o médico digitar do zero. Não mexe em razaoSocial/cnpj (só o médico
 * confirmando via upsertDoctorFiscalProfile grava o dado como definitivo).
 */
export async function upsertDoctorFiscalSuggestion(params: {
    doctorId: string;
    razaoSocial: string;
    cnpj: string;
}) {
    const db = getDb();
    const [doctor] = await db
        .select({ id: doctors.id, metadata: doctors.metadata, fullName: doctors.fullName })
        .from(doctors)
        .where(eq(doctors.id, params.doctorId))
        .limit(1);

    if (!doctor) {
        throw new Error("doctor_not_found");
    }

    const nextMetadata = isPlainObject(doctor.metadata)
        ? { ...doctor.metadata }
        : {};

    nextMetadata.suggestedRazaoSocial = params.razaoSocial;
    nextMetadata.suggestedCnpj = params.cnpj;

    await db.update(doctors)
        .set({
            metadata: nextMetadata,
            updatedAt: new Date(),
        })
        .where(eq(doctors.id, doctor.id));

    return { doctorId: doctor.id, fullName: doctor.fullName };
}

export async function upsertDoctorFiscalProfile(params: {
    doctorId: string;
    razaoSocial: string;
    cnpj: string;
}) {
    const db = getDb();
    const [doctor] = await db
        .select({ id: doctors.id, metadata: doctors.metadata, fullName: doctors.fullName })
        .from(doctors)
        .where(eq(doctors.id, params.doctorId))
        .limit(1);

    if (!doctor) {
        throw new Error("doctor_not_found");
    }

    const nextMetadata = isPlainObject(doctor.metadata)
        ? { ...doctor.metadata }
        : {};

    nextMetadata.razaoSocial = params.razaoSocial;
    nextMetadata.cnpj = params.cnpj;

    await db.update(doctors)
        .set({
            metadata: nextMetadata,
            updatedAt: new Date(),
        })
        .where(eq(doctors.id, doctor.id));

    return {
        doctorId: doctor.id,
        fullName: doctor.fullName,
        razaoSocial: params.razaoSocial,
        cnpj: params.cnpj,
    };
}
