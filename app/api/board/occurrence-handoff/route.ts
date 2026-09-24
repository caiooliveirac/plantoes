import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { publishBoardUpdate } from "@/lib/board-live";
import {
    OccurrenceHandoffError,
    getOccurrenceHandoffState,
    saveOccurrenceHandoffCounts,
} from "@/services/occurrence-handoff.service";

// Passagem de ocorrências. Público por decisão da chefia (2026-09-24): quem sai
// informa a contagem sem login, como o quadro, que também é público. A proteção
// é de escopo (só ramal que sai, só dentro da janela, números 0–99) e de volume
// (limite por IP), e toda gravação recalcula a divisão no servidor.

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
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
    // Cloudflare na frente: cf-connecting-ip é o cliente; x-real-ip (nginx) é o
    // fallback. x-forwarded-for não entra — o cliente pode forjá-lo.
    const ip = request.headers.get("cf-connecting-ip")?.trim() || request.headers.get("x-real-ip")?.trim() || "local";
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
