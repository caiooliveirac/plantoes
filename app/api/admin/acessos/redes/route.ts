import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { esquecerCentralDoPortao } from "@/services/acessos-portao.service";
import { RotuloDeRedeError, removerRotuloDeRede, salvarRotuloDeRede } from "@/services/acessos-redes.service";

/* Monitor de acessos: o admin nomeia uma faixa de rede (Central, Vitalmed…).
   `central` entra na hora na rede do plantão do portão de turno. */
const salvar = z.object({
    faixa: z.string().max(60),
    kind: z.enum(["central", "suspeita", "conhecida"]),
    label: z.string().max(80),
    note: z.string().max(500).nullable().optional(),
});
const remover = z.object({ faixa: z.string().max(60) });

async function tratar(request: NextRequest, acao: (adminId: string, corpo: unknown) => Promise<void>) {
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "Banco indisponível." }, { status: 503 });
    try {
        const session = await requireAuthenticatedSession(["admin"]);
        await acao(session.user.id, await request.json().catch(() => null));
        esquecerCentralDoPortao();
        return NextResponse.json({ ok: true });
    } catch (error) {
        if (error instanceof AuthError || error instanceof RotuloDeRedeError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
    }
}

export async function POST(request: NextRequest) {
    return tratar(request, async (adminId, corpo) => {
        const parsed = salvar.safeParse(corpo);
        if (!parsed.success) throw new RotuloDeRedeError(400, "Pedido inválido.");
        await salvarRotuloDeRede(parsed.data, adminId);
    });
}

export async function DELETE(request: NextRequest) {
    return tratar(request, async (adminId, corpo) => {
        const parsed = remover.safeParse(corpo);
        if (!parsed.success) throw new RotuloDeRedeError(400, "Pedido inválido.");
        await removerRotuloDeRede(parsed.data.faixa, adminId);
    });
}
