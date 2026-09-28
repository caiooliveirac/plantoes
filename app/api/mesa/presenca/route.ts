import { NextResponse, type NextRequest } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, contaNaMesa, mesaLiberadaPara, requireAuthenticatedSession } from "@/lib/auth/server";
import { MENSAGEM_FORA_DO_PLANTAO } from "@/modules/acessos/portao";
import { MENSAGEM_BLOQUEADA, MENSAGEM_OCUPADA, lerBatida, modoPresenca } from "@/modules/acessos/presenca";
import { baterPresenca } from "@/services/mesa-presenca.service";

/* Batida da Mesa (docs/presenca-mesa.md): a aba visível manda
   { visivel, paradoSeg } a cada 15 s. Responde sempre com `estado`:
   ok (200), ocupada (423 VIEW_LEASE_HELD), bloqueada (401 MESA_BLOQUEADA),
   fora_do_plantao (403), isento (admin ou presença desligada, 200).

   Mais de uma batida a cada 4 s pelo mesmo aparelho e conta é descartada
   (429) sem tocar no banco — duas abas do mesmo aparelho batem juntas. */
const INTERVALO_MINIMO_MS = 4_000;
const ultimaBatida = new Map<string, number>();

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) return NextResponse.json({ estado: "isento" });
    let session;
    try {
        session = await requireAuthenticatedSession(undefined, { allowPasswordChange: true });
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 401;
        return NextResponse.json({ estado: "sem_sessao", codigo: "SEM_SESSAO" }, { status });
    }
    if (!(await mesaLiberadaPara(session))) {
        return NextResponse.json({ estado: "fora_do_plantao", mensagem: MENSAGEM_FORA_DO_PLANTAO }, { status: 403 });
    }
    const conta = await contaNaMesa(session);
    const modo = modoPresenca();
    if (!conta || modo === "desligado") return NextResponse.json({ estado: "isento" });

    const chave = `${conta.userId}|${conta.aparelhoId}`;
    const agora = Date.now();
    const anterior = ultimaBatida.get(chave);
    if (anterior && agora - anterior < INTERVALO_MINIMO_MS) {
        return NextResponse.json({ estado: "repetida" }, { status: 429 });
    }
    ultimaBatida.set(chave, agora);
    if (ultimaBatida.size > 10_000) {
        for (const [k, t] of ultimaBatida) if (agora - t > 60_000) ultimaBatida.delete(k);
    }

    const sinal = lerBatida(await request.json().catch(() => null));
    const resposta = await baterPresenca(conta, { ...sinal, humanoAgora: false }, modo);
    if (resposta.estado === "ocupada") {
        return NextResponse.json({ ...resposta, codigo: "VIEW_LEASE_HELD", mensagem: MENSAGEM_OCUPADA }, { status: 423 });
    }
    if (resposta.estado === "bloqueada") {
        return NextResponse.json({ ...resposta, codigo: "MESA_BLOQUEADA", mensagem: MENSAGEM_BLOQUEADA }, { status: 401 });
    }
    return NextResponse.json(resposta);
}
