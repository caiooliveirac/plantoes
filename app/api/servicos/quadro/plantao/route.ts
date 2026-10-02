/* ==========================================================================
   Plantão agora, para o quadro informativo da Central (quadro.mnrs.com.br).

   Quem chama: o app do quadro, servidor↔servidor em 127.0.0.1. Portão: o
   mesmo token de serviço do porteiro (ESCALA_SSO_TOKEN no header
   x-escala-token, tempo constante). Sem a variável: 503.

   Resposta:
     { ok: true,
       turno: { data: "YYYY-MM-DD", turno: "SD" | "SN" },
       enfermeiros: [{ nome, telefone, posicao }], // registrados pela chefia na Mesa; posicao ADM|DISP|FLUXO|null
       enfermeiro: { nome, telefone } | null,   // legado: o primeiro de `enfermeiros`
       chefe: { nome } | null,                   // quem ocupa a 2031 agora
       bases: [{ codigo, nome, ativa, medico }],
       ramais: [{ ramal, nome, ativa, medico, funcao }] }

   Bases = o mesmo read model da Mesa (listInterventionBoard): só bases
   ativas no cadastro (a diurna some à noite), na ordem do quadro. `ativa`
   false = desativada neste turno pela chefia. `medico` = titular no quadro
   agora (ocupação com chegada no quadro e sem handoff), com a dupla como
   "Fulano + Beltrano"; null = sem cobertura.

   Ramais = o read model da regulação na Mesa (listRegulationBoard), mesma
   regra: `medico` só com ocupação ativa no quadro agora; null = vazio.
   `funcao` = role_label da ocupação (RMT, MRV, PSIQ, RECIP…), null sem médico.
   ========================================================================== */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { hasDatabaseUrl } from "@/db";
import { turnoDoMomento } from "@/modules/operational/enfermeiro-plantao";
import { listInterventionBoard, listRegulationBoard, type InterventionBoardRow, type RegulationBoardRow } from "@/services/board.service";
import { chefeDePlantaoAtual } from "@/services/chefe-de-plantao.service";
import { enfermeirosDoTurno } from "@/services/enfermeiro-plantao.service";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

function nomeCurto(nome: string | null, exibicao: string | null) {
    const escolhido = (exibicao ?? "").trim() || (nome ?? "").trim();
    return escolhido || null;
}

function medicoDaLinha(linha: InterventionBoardRow | RegulationBoardRow) {
    if (linha.status !== "active") return null;
    const titular = nomeCurto(linha.doctorName, linha.displayName);
    if (!titular) return null;
    // dupla na mesma base só existe na intervenção
    const dupla = ("companionOccupants" in linha ? linha.companionOccupants ?? [] : [])
        .map((outro) => nomeCurto(outro.doctorName, outro.displayName))
        .filter((nome): nome is string => Boolean(nome));
    return [titular, ...dupla].join(" + ");
}

export async function GET(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) {
        return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    }
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const turno = turnoDoMomento();
    try {
        const [enfermeiros, chefe, bases, ramais] = await Promise.all([
            enfermeirosDoTurno(turno),
            chefeDePlantaoAtual(),
            listInterventionBoard(),
            listRegulationBoard(),
        ]);
        return NextResponse.json({
            ok: true,
            turno: { data: turno.data, turno: turno.turno },
            enfermeiros: enfermeiros.map((item) => ({ nome: item.nome, telefone: item.telefone, posicao: item.posicao })),
            // Legado (um só): o primeiro registrado.
            enfermeiro: enfermeiros[0] ? { nome: enfermeiros[0].nome, telefone: enfermeiros[0].telefone } : null,
            chefe: chefe ? { nome: chefe.nome } : null,
            bases: bases.map((linha) => ({
                codigo: linha.baseCode,
                nome: linha.baseLabel,
                ativa: linha.status !== "disabled",
                medico: medicoDaLinha(linha),
            })),
            ramais: ramais.map((linha) => ({
                ramal: linha.postCode,
                nome: linha.postLabel,
                ativa: linha.status !== "disabled",
                medico: medicoDaLinha(linha),
                funcao: linha.status === "active" ? linha.roleLabel : null,
            })),
        }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        console.error(`[quadro-plantao] ${error instanceof Error ? error.message : String(error)}`);
        return NextResponse.json({ error: "unavailable" }, { status: 500 });
    }
}
