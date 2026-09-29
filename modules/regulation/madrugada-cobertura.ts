// Grava a cobertura de madrugada (docs/madrugada.md): uma ocupação de
// regulação de QUEM COBRE, marcada `madrugada_cobertura`, apontando a ocupação
// coberta.
//
// - Entra SEM board (board_started_at nulo): fica fora do índice de
//   um-titular-por-ramal e não rende/desloca ninguém. O quadro
//   (listRegulationBoard) a mostra mesmo assim e esconde a coberta.
// - Não passa por startRegulationOccupancy de propósito: nada de continuidade,
//   tomada, deslocamento, banco de horas nem pagamento. A ocupação coberta não
//   é tocada — segue paga e no banco de horas do titular.
// - Ramal ocupado por outro titular também vale: é temporário. Ele sai do
//   quadro enquanto a cobertura vale e volta depois.
// - Expira sozinha no fim da janela (expireStaleRegulationOccupancies), e aí o
//   coberto volta ao quadro se ainda estiver aberto.

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { publishBoardUpdate } from "@/lib/board-live";
import { resolveFixedOperationalRole } from "@/modules/operational/roles";

export const MADRUGADA_NOTES_MARKER = "[MADRUGADA]";

/** Erro com texto pronto para o usuário do bot. */
export class MadrugadaCoverageError extends Error {}

export async function startMadrugadaCoverage(input: {
    covererDoctorId: string;
    postCode: string;
    coveredOccupancyId: string;
    startedAt: Date;
    scheduledStartAt: Date;
    scheduledEndAt: Date;
    createdByUserId?: string | null;
}) {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
        const post = await tx.query.regulationPosts.findFirst({
            where: and(eq(regulationPosts.code, input.postCode), eq(regulationPosts.isActive, true)),
            columns: { id: true, code: true },
        });
        if (!post) {
            throw new MadrugadaCoverageError(`Não conheço o ramal ${input.postCode}.`);
        }

        const covered = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, input.coveredOccupancyId),
        });
        if (!covered || covered.endedAt) {
            throw new MadrugadaCoverageError("Esse médico já saiu do quadro. Avise de novo para ver a lista atual.");
        }
        if (covered.madrugadaCobertura) {
            throw new MadrugadaCoverageError("Esse já é uma cobertura de madrugada — escolha o titular.");
        }
        if (covered.doctorId === input.covererDoctorId) {
            throw new MadrugadaCoverageError("Você não pode cobrir o próprio plantão.");
        }

        const coveredDoctor = await tx.query.doctors.findFirst({
            where: eq(doctors.id, covered.doctorId),
            columns: { fullName: true, displayName: true },
        });
        const coveredName = coveredDoctor?.displayName || coveredDoctor?.fullName || "titular";

        const alreadyCovered = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.madrugadaCobreOcupacaoId, covered.id),
                eq(regulationOccupancies.madrugadaCobertura, true),
                isNull(regulationOccupancies.endedAt),
                ne(regulationOccupancies.doctorId, input.covererDoctorId),
            ),
        });
        if (alreadyCovered) {
            throw new MadrugadaCoverageError(`${coveredName} já tem alguém na madrugada por ele(a).`);
        }

        // Ramal declarado com outro titular: vale mesmo assim — é temporário
        // (ele trabalha no outro horário da noite). Ele sai do quadro enquanto
        // a cobertura vale (listRegulationBoard) e volta depois; a ocupação
        // dele não é tocada.
        const holder = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                isNull(regulationOccupancies.endedAt),
                isNotNull(regulationOccupancies.boardStartedAt),
                ne(regulationOccupancies.id, covered.id),
                ne(regulationOccupancies.doctorId, input.covererDoctorId),
            ),
        });
        const holderDoctor = holder
            ? await tx.query.doctors.findFirst({
                where: eq(doctors.id, holder.doctorId),
                columns: { fullName: true, displayName: true },
            })
            : null;
        const releasedName = holder ? (holderDoctor?.displayName || holderDoctor?.fullName || "outro médico") : null;
        const otherCoverage = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                eq(regulationOccupancies.madrugadaCobertura, true),
                isNull(regulationOccupancies.endedAt),
                ne(regulationOccupancies.doctorId, input.covererDoctorId),
            ),
        });
        if (otherCoverage) {
            throw new MadrugadaCoverageError(`O ramal ${post.code} já tem outra cobertura de madrugada. Use outro ramal (ex.: 2266–2270).`);
        }

        // Reenvio de quem já cobre: a cobertura anterior dá lugar à nova.
        const now = new Date();
        await tx.update(regulationOccupancies)
            .set({ endedAt: input.startedAt, actualEndedAt: input.startedAt, updatedAt: now })
            .where(and(
                eq(regulationOccupancies.doctorId, input.covererDoctorId),
                eq(regulationOccupancies.madrugadaCobertura, true),
                isNull(regulationOccupancies.endedAt),
            ));

        const [created] = await tx.insert(regulationOccupancies).values({
            doctorId: input.covererDoctorId,
            continuityGroupId: randomUUID(),
            postId: post.id,
            scheduledStartAt: input.scheduledStartAt,
            scheduledEndAt: input.scheduledEndAt,
            startedAt: input.startedAt,
            boardStartedAt: null,
            shiftLabel: "SN",
            roleLabel: resolveFixedOperationalRole({ domain: "regulation", code: post.code, shiftLabel: "SN" }),
            ramalLabel: post.code,
            source: "telegram",
            notes: `${MADRUGADA_NOTES_MARKER} por ${coveredName}`,
            createdByUserId: input.createdByUserId ?? null,
            madrugadaCobertura: true,
            madrugadaCobreOcupacaoId: covered.id,
        }).returning();

        return { occupancy: created, coveredName, postCode: post.code, releasedName };
    });

    publishBoardUpdate(`regulation:madrugada:${result.occupancy.id}`);
    return result;
}
