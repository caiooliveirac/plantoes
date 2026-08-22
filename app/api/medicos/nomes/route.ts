/**
 * Nomes dos médicos para o app irmão (Escalas & Trocas) — SOMENTE LEITURA.
 *
 * POR QUE ESTA ROTA EXISTE. O nome preferido ("Briang Seguir", "Luiz Eduardo")
 * é dado CURADO por gente, e mora aqui: 186 dos 188 médicos ativos têm
 * display_name, e 179 deles diferem do nome completo. Do outro lado, a escala
 * vinha DERIVANDO o nome curto por heurística (primeiro + último sobrenome) e
 * errava a maioria — "Briang Ibarra" em vez de "Briang Seguir", "Maria Gusmão"
 * em vez de "Maria Coppieters".
 *
 * Nome errado num quadro operacional não é detalhe estético: é o chefe
 * procurando no grupo alguém que ninguém chama assim.
 *
 * Regra de dono: identidade de médico é DESTE app. O outro consome e cacheia;
 * não inventa, não corrige, não guarda como verdade própria.
 *
 * Portão: ESCALA_SSO_TOKEN — o mesmo de /api/auth/verificar-escala. Falha
 * fechada: sem a variável, 503.
 *
 * Não devolve e-mail, telefone, CRM nem contrato. Só o necessário para
 * escrever um nome na tela: a chave de junção e as duas formas do nome.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { doctors } from "@/db/schema";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) {
        console.error("[medicos-nomes] ESCALA_SSO_TOKEN ausente — rota desligada.");
        return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    }
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const linhas = await getDb()
        .select({
            normalizedName: doctors.normalizedName,
            fullName: doctors.fullName,
            displayName: doctors.displayName,
        })
        .from(doctors)
        .where(eq(doctors.isActive, true));

    return NextResponse.json(
        {
            ok: true,
            geradoEm: new Date().toISOString(),
            medicos: linhas.map((l) => ({
                normalizedName: l.normalizedName,
                fullName: l.fullName,
                // sem display_name cadastrado, o outro lado que decida — devolver
                // o completo aqui esconderia a lacuna e ninguém iria cadastrar
                displayName: l.displayName ?? null,
            })),
        },
        { headers: { "Cache-Control": "private, max-age=300" } },
    );
}
