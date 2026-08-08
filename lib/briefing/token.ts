/**
 * Porta das rotas de briefing (as que o secretário `tom` consome).
 *
 * Vive fora das rotas porque agora são duas — o briefing de agora e o histórico
 * — e autenticação repetida em dois arquivos é autenticação que um dia diverge.
 * Sem BRIEFING_TOKEN configurado a resposta é 503: endpoint aberto com nome de
 * médico e saldo de contrato, não.
 */
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { hasDatabaseUrl } from "@/db";

function tokenOk(received: string, expected: string): boolean {
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    // timingSafeEqual exige o mesmo tamanho; comparar antes já vaza o tamanho,
    // e tamanho de token não é o segredo.
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Devolve a resposta de recusa, ou `null` quando pode seguir. */
export function guardBriefingRequest(request: NextRequest): NextResponse | null {
    const expected = process.env.BRIEFING_TOKEN?.trim();
    if (!expected) {
        return NextResponse.json({ error: "BRIEFING_TOKEN is not configured." }, { status: 503 });
    }
    if (!tokenOk(request.headers.get("x-briefing-token") ?? "", expected)) {
        return NextResponse.json({ error: "Invalid briefing token." }, { status: 401 });
    }
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    return null;
}
