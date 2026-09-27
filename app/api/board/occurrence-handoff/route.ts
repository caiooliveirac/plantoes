import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireSessionForRead } from "@/lib/auth/server";
import { publishBoardUpdate } from "@/lib/board-live";
import { getLoginClientIp } from "@/modules/auth/login-rate-limit";
import {
    OccurrenceHandoffError,
    getOccurrenceHandoffState,
    saveOccurrenceHandoffCounts,
} from "@/services/occurrence-handoff.service";

// Passagem de ocorrências. Exige sessão (qualquer papel) desde 2026-09-27, junto
// com o quadro fechado (lib/auth/portao.ts): revoga a decisão de 2026-09-24, que
// a deixava pública porque o quadro também era. Quem sai já está no quadro, e
// portanto logado. Continuam a proteção de escopo (só ramal que sai, só dentro
// da janela, números 0–99) e de volume (limite por IP), e toda gravação
// recalcula a divisão no servidor.

async function sessionError() {
    try {
        await requireSessionForRead();
        return null;
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 401;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }
}

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    const denied = await sessionError();
    if (denied) return denied;
    const state = await getOccurrenceHandoffState();
    if (!state) return NextResponse.json({ state: null });
    const { chatId: _chatId, doctorIds: _doctorIds, ...publicState } = state;
    return NextResponse.json({ state: publicState }, { headers: { "Cache-Control": "no-store" } });
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
const hits = new Map<string, number[]>();

function rateLimited(ip: string, now: number) {
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 2000) {
        for (const [key, times] of hits) if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key);
    }
    return recent.length > MAX_PER_WINDOW;
}

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    const denied = await sessionError();
    if (denied) return denied;
    // Mesma extração do login: cf-connecting-ip → x-real-ip, nunca x-forwarded-for.
    const ip = getLoginClientIp(request.headers) || "local";
    if (rateLimited(ip, Date.now())) {
        return NextResponse.json({ error: "Muitas tentativas. Espere um minuto." }, { status: 429 });
    }

    const body = await request.json().catch(() => null) as {
        slot?: unknown; ramal?: unknown; aguardando?: unknown; regulado?: unknown;
    } | null;
    const slot = typeof body?.slot === "string" ? body.slot : "";
    const ramal = typeof body?.ramal === "string" ? body.ramal : "";
    const aguardando = Number(body?.aguardando);
    const regulado = Number(body?.regulado);
    if (!/^\d{2}:\d{2}$/.test(slot) || !ramal || ramal.length > 16
        || !Number.isFinite(aguardando) || !Number.isFinite(regulado)
        || aguardando < 0 || regulado < 0 || aguardando > 99 || regulado > 99) {
        return NextResponse.json({ error: "Informe horário, ramal e números de 0 a 99." }, { status: 400 });
    }

    try {
        const result = await saveOccurrenceHandoffCounts({ slot, ramal, counts: { aguardando, regulado } });
        publishBoardUpdate("occurrence-handoff");
        return NextResponse.json({ transfers: result.record.transfers, counts: result.record.counts });
    } catch (error) {
        if (error instanceof OccurrenceHandoffError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error("[occurrence-handoff] save failed", error);
        return NextResponse.json({ error: "Não foi possível salvar agora." }, { status: 500 });
    }
}
