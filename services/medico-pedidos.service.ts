/**
 * Pedidos do próprio médico pela web que a chefia decide (tabela
 * pedidos_do_medico, migration 0053). Hoje só `continuar`: o médico em turno
 * avisa que vai prolongar para o turno seguinte (dobra). Nada muda no quadro
 * até admin/chief aceitar — aí a continuação nasce pelo mesmo caminho do bot
 * (`continueRegulationOccupancy` / `continueInterventionOccupancy`, que usam a
 * virada mais próxima); recusar só marca.
 */
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, doctors, interventionOccupancies, pedidosDoMedico, regulationOccupancies } from "@/db/schema";
import { continueInterventionOccupancy } from "@/modules/intervention/service";
import { avisarCoordenacao } from "@/modules/operational/arrival-check";
import { resolveOccupantCoverageEndAt } from "@/modules/operational/board-rules";
import { findActiveOccupancyByDoctorId } from "@/modules/operational/ocupacao-ativa";
import { continueRegulationOccupancy } from "@/modules/regulation/service";
import {
    PresencaRecusada,
    codigoDoAlvo,
    dominioDe,
    nomeDoMedico,
    ocupacaoDeclaradaDe,
    type DominioOperacional,
    type MedicoDaSessao,
    type OcupacaoDeclarada,
} from "@/services/medico-presenca.service";

export type StatusDoPedido = "pendente" | "aceito" | "recusado";

export interface PedidoDoMedico {
    id: string;
    kind: "continuar";
    status: StatusDoPedido;
    createdAt: string;
    ocupacao: OcupacaoDeclarada & { shiftLabel: string | null };
}

export async function pedirContinuacao(params: { medico: MedicoDaSessao; agora?: Date }): Promise<PedidoDoMedico> {
    const agora = params.agora ?? new Date();
    const { doctorId } = params.medico;
    const db = getDb();

    const ativa = await findActiveOccupancyByDoctorId(doctorId, agora);
    if (!ativa) {
        throw new PresencaRecusada(409, { error: "fora_de_turno" });
    }
    const ocupacao = { ...ocupacaoDeclaradaDe(ativa), shiftLabel: ativa.shiftLabel };

    const pendente = await db.query.pedidosDoMedico.findFirst({
        where: and(eq(pedidosDoMedico.occupancyId, ativa.occupancyId), eq(pedidosDoMedico.kind, "continuar"), eq(pedidosDoMedico.status, "pendente")),
    });
    if (pendente) {
        throw new PresencaRecusada(409, { error: "pedido_ja_pendente", pedido: { id: pendente.id, createdAt: pendente.createdAt.toISOString() } });
    }

    let criado;
    try {
        [criado] = await db.insert(pedidosDoMedico).values({
            doctorId,
            kind: "continuar",
            domain: ocupacao.domain,
            occupancyId: ativa.occupancyId,
            status: "pendente",
            payload: ocupacao,
            createdAt: agora,
        }).returning();
    } catch (error) {
        // Corrida com outro clique: o índice parcial único garante um pendente por ocupação.
        if (error instanceof Error && /pedidos_do_medico_pendente_idx/.test(error.message)) {
            throw new PresencaRecusada(409, { error: "pedido_ja_pendente" });
        }
        throw error;
    }

    // Aviso à coordenação (admins no Telegram + WhatsApp, quando configurados).
    // Melhor esforço: o pedido já está gravado e aparece na Mesa de qualquer jeito.
    void nomeDoMedico(doctorId)
        .then((nome) => avisarCoordenacao(
            `⏩ Pedido de continuação\n\n${nome} (${ocupacao.code}${ocupacao.shiftLabel ? `, ${ocupacao.shiftLabel}` : ""}) avisou pela web que vai prolongar para o turno seguinte.\nDecida na Mesa: aceitar cria a continuação; recusar só registra.`,
            `pedido-continuar:${criado.id}`,
        ))
        .catch((erro: unknown) => console.error("[pedidos-do-medico] aviso falhou", erro));

    return { id: criado.id, kind: "continuar", status: "pendente", createdAt: criado.createdAt.toISOString(), ocupacao };
}

export interface PedidoPendenteParaMesa extends PedidoDoMedico {
    medico: { id: string; nome: string };
    /** Turno em curso da ocupação (SD/SN/P) no momento da listagem. */
    turnoAtual: string | null;
}

export async function listarPedidosPendentes(): Promise<PedidoPendenteParaMesa[]> {
    const db = getDb();
    const linhas = await db
        .select({
            id: pedidosDoMedico.id,
            kind: pedidosDoMedico.kind,
            status: pedidosDoMedico.status,
            createdAt: pedidosDoMedico.createdAt,
            domain: pedidosDoMedico.domain,
            occupancyId: pedidosDoMedico.occupancyId,
            payload: pedidosDoMedico.payload,
            doctorId: doctors.id,
            fullName: doctors.fullName,
            displayName: doctors.displayName,
        })
        .from(pedidosDoMedico)
        .innerJoin(doctors, eq(doctors.id, pedidosDoMedico.doctorId))
        .where(eq(pedidosDoMedico.status, "pendente"))
        .orderBy(asc(pedidosDoMedico.createdAt));

    const resultado: PedidoPendenteParaMesa[] = [];
    for (const linha of linhas) {
        const domain = linha.domain as DominioOperacional;
        const ocupacao = domain === "regulation"
            ? await db.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, linha.occupancyId), columns: { postId: true, startedAt: true, shiftLabel: true } })
            : await db.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, linha.occupancyId), columns: { baseId: true, startedAt: true, shiftLabel: true } });
        const targetId = ocupacao ? ("postId" in ocupacao ? ocupacao.postId : ocupacao.baseId) : null;
        const payload = (linha.payload ?? {}) as Partial<OcupacaoDeclarada & { shiftLabel: string | null }>;
        resultado.push({
            id: linha.id,
            kind: "continuar",
            status: "pendente",
            createdAt: linha.createdAt.toISOString(),
            medico: { id: linha.doctorId, nome: linha.displayName?.trim() || linha.fullName },
            turnoAtual: ocupacao?.shiftLabel ?? payload.shiftLabel ?? null,
            ocupacao: {
                domain,
                occupancyId: linha.occupancyId,
                targetId: targetId ?? payload.targetId ?? 0,
                code: (targetId ? await codigoDoAlvo(domain, targetId) : null) ?? payload.code ?? "?",
                startedAt: (ocupacao?.startedAt ?? (payload.startedAt ? new Date(payload.startedAt) : linha.createdAt)).toISOString(),
                shiftLabel: ocupacao?.shiftLabel ?? payload.shiftLabel ?? null,
            },
        });
    }
    return resultado;
}

/**
 * A continuação do bot referencia a virada MAIS PRÓXIMA do aviso e, dita no
 * meio do plantão, só reforça o bloco atual (caso Uenderson — ninguém promete
 * 12h a mais ao chegar). O pedido pela web é, por definição, "prolongar para
 * o turno SEGUINTE", e a chefia o decide a qualquer hora do turno: por isso a
 * continuação é referenciada no fim da cobertura atual (a virada que o médico
 * pediu), pelo mesmo continue*Occupancy. Decidida já depois da virada, vale o
 * agora, como no bot.
 */
async function instanteDaContinuacao(domain: DominioOperacional, occupancyId: string, agora: Date): Promise<Date> {
    const db = getDb();
    const ocupacao = domain === "regulation"
        ? await db.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, occupancyId), columns: { startedAt: true, boardStartedAt: true, scheduledEndAt: true, shiftLabel: true } })
        : await db.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, occupancyId), columns: { startedAt: true, boardStartedAt: true, scheduledEndAt: true, shiftLabel: true } });
    const fimDaCobertura = ocupacao ? resolveOccupantCoverageEndAt(ocupacao) : null;
    if (!fimDaCobertura) return agora;
    const umMinutoAntesDaVirada = new Date(fimDaCobertura.getTime() - 60_000);
    return agora.getTime() >= umMinutoAntesDaVirada.getTime() ? agora : umMinutoAntesDaVirada;
}

export interface DecisaoDoPedido {
    id: string;
    status: StatusDoPedido;
    decidedAt: string;
    /** Preenchida quando aceito: a ocupação continuada e a nova janela. */
    continuacao: { occupancyId: string; scheduledEndAt: string | null; shiftLabel: string | null } | null;
}

export async function decidirPedido(params: {
    id: string;
    decisao: "aceito" | "recusado";
    note?: string | null;
    actorUserId: string;
    agora?: Date;
}): Promise<DecisaoDoPedido> {
    const agora = params.agora ?? new Date();
    const db = getDb();
    const pedido = await db.query.pedidosDoMedico.findFirst({ where: eq(pedidosDoMedico.id, params.id) });
    if (!pedido) {
        throw new PresencaRecusada(404, { error: "pedido_nao_encontrado" });
    }
    if (pedido.status !== "pendente") {
        throw new PresencaRecusada(409, { error: "pedido_ja_decidido", status: pedido.status });
    }

    let continuacao: DecisaoDoPedido["continuacao"] = null;
    if (params.decisao === "aceito") {
        const notas = `Continuação pedida pelo médico pela web e aceita pela chefia.${params.note?.trim() ? ` ${params.note.trim()}` : ""}`;
        try {
            const continuedAt = await instanteDaContinuacao(pedido.domain as DominioOperacional, pedido.occupancyId, agora);
            const continuada = pedido.domain === "regulation"
                ? await continueRegulationOccupancy(pedido.occupancyId, { notes: notas, continuedAt }, params.actorUserId)
                : await continueInterventionOccupancy(pedido.occupancyId, { notes: notas, continuedAt }, params.actorUserId);
            continuacao = {
                occupancyId: continuada.id,
                scheduledEndAt: continuada.scheduledEndAt?.toISOString() ?? null,
                shiftLabel: continuada.shiftLabel ?? null,
            };
        } catch (error) {
            // Ocupação já encerrada / base diurna etc.: o pedido segue pendente para
            // a chefia recusar com motivo, em vez de sumir com ele.
            throw new PresencaRecusada(409, { error: "continuacao_falhou", motivo: error instanceof Error ? error.message : String(error) });
        }
    }

    const [atualizado] = await db.update(pedidosDoMedico)
        .set({
            status: params.decisao,
            decidedAt: agora,
            decidedByUserId: params.actorUserId,
            decisionNote: params.note?.trim() || null,
        })
        .where(and(eq(pedidosDoMedico.id, pedido.id), eq(pedidosDoMedico.status, "pendente")))
        .returning();
    if (!atualizado) {
        throw new PresencaRecusada(409, { error: "pedido_ja_decidido" });
    }

    await db.insert(auditLogs).values({
        actorUserId: params.actorUserId,
        action: `pedido_do_medico.${pedido.kind}.${params.decisao}`,
        entityType: "pedido_do_medico",
        entityId: pedido.id,
        details: {
            doctorId: pedido.doctorId,
            domain: pedido.domain,
            occupancyId: pedido.occupancyId,
            note: params.note?.trim() || null,
            continuacao,
        },
    });

    return { id: atualizado.id, status: params.decisao, decidedAt: agora.toISOString(), continuacao };
}

export { dominioDe };
