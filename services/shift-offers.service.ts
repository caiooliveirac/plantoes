import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
    doctors,
    interventionBases,
    regulationPosts,
    scheduledShifts,
    shiftOfferBids,
    shiftOffers,
    shiftSwaps,
} from "@/db/schema";
import { effectiveShiftOwner } from "@/services/shift-swaps.service";

/** Um $ a cada R$100 de bônus — código implícito do mural, sem cifra explícita. */
export function bonusIcons(bonusBrl: number, cap = 10) {
    const count = Math.max(0, Math.floor(bonusBrl / 100));
    return count <= cap ? "$".repeat(count) : `${"$".repeat(cap)}+`;
}

export interface OfferBidView {
    id: string;
    doctorId: string;
    doctorName: string;
    kind: string;
    counterShiftId: string | null;
    counterShiftLabel: string | null;
    note: string | null;
    status: string;
}

export interface OfferView {
    id: string;
    shiftId: string;
    operationalDate: string;
    shiftLabel: string;
    domain: string;
    targetLabel: string;
    offeredByDoctorId: string;
    offeredByDoctorName: string;
    bonusBrl: number;
    bonusIcons: string;
    note: string | null;
    status: string;
    settledSwapId: string | null;
    bids: OfferBidView[];
}

export interface SwapBoardDay {
    operationalDate: string;
    weekday: number;
    offers: { SD: OfferView[]; SN: OfferView[] };
}

function addDays(date: string, days: number) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Mural de trocas: os próximos `days` dias em ordem, diurno e noturno
 * separados, com as ofertas abertas (e comprometidas aguardando chefia) de
 * quem quer que tenha ofertado plantão naquele dia.
 */
export async function getSwapBoard(fromDate: string, days = 14): Promise<SwapBoardDay[]> {
    const db = getDb();
    const untilDate = addDays(fromDate, days);

    const offerRows = await db.select().from(shiftOffers)
        .where(inArray(shiftOffers.status, ["open", "committed"]))
        .orderBy(asc(shiftOffers.createdAt));

    const shiftIds = [...new Set(offerRows.map((row) => row.shiftId))];
    const shiftRows = shiftIds.length
        ? await db.select().from(scheduledShifts).where(inArray(scheduledShifts.id, shiftIds))
        : [];
    const shiftIndex = new Map(shiftRows.map((row) => [row.id, row]));

    const visibleOffers = offerRows.filter((offer) => {
        const shift = shiftIndex.get(offer.shiftId);
        return shift && shift.status === "planned"
            && shift.operationalDate >= fromDate && shift.operationalDate < untilDate;
    });

    const offerIds = visibleOffers.map((offer) => offer.id);
    const bidRows = offerIds.length
        ? await db.select().from(shiftOfferBids)
            .where(and(inArray(shiftOfferBids.offerId, offerIds), inArray(shiftOfferBids.status, ["pending", "chosen"])))
            .orderBy(asc(shiftOfferBids.createdAt))
        : [];

    const counterShiftIds = [...new Set(bidRows.map((bid) => bid.counterShiftId).filter(Boolean))] as string[];
    const counterShifts = counterShiftIds.length
        ? await db.select().from(scheduledShifts).where(inArray(scheduledShifts.id, counterShiftIds))
        : [];
    const counterIndex = new Map(counterShifts.map((row) => [row.id, row]));

    const [doctorRows, postRows, baseRows] = await Promise.all([
        db.select().from(doctors),
        db.select().from(regulationPosts),
        db.select().from(interventionBases),
    ]);
    const doctorNames = new Map(doctorRows.map((row) => [row.id, row.displayName ?? row.fullName]));
    const postLabels = new Map(postRows.map((row) => [row.id, row.label]));
    const baseLabels = new Map(baseRows.map((row) => [row.id, row.label]));

    function targetLabel(shift: typeof shiftRows[number]) {
        if (shift.postId != null) return postLabels.get(shift.postId) ?? `ramal ${shift.postId}`;
        if (shift.baseId != null) return baseLabels.get(shift.baseId) ?? `base ${shift.baseId}`;
        return shift.domain;
    }

    const bidsByOffer = new Map<string, OfferBidView[]>();
    for (const bid of bidRows) {
        const counter = bid.counterShiftId ? counterIndex.get(bid.counterShiftId) : null;
        const list = bidsByOffer.get(bid.offerId) ?? [];
        list.push({
            id: bid.id,
            doctorId: bid.doctorId,
            doctorName: doctorNames.get(bid.doctorId) ?? "?",
            kind: bid.kind,
            counterShiftId: bid.counterShiftId,
            counterShiftLabel: counter ? `${counter.operationalDate} · ${counter.shiftLabel} · ${targetLabel(counter)}` : null,
            note: bid.note,
            status: bid.status,
        });
        bidsByOffer.set(bid.offerId, list);
    }

    const board: SwapBoardDay[] = [];
    for (let index = 0; index < days; index += 1) {
        const operationalDate = addDays(fromDate, index);
        const [y, m, d] = operationalDate.split("-").map(Number);
        board.push({
            operationalDate,
            weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
            offers: { SD: [], SN: [] },
        });
    }
    const dayIndex = new Map(board.map((day) => [day.operationalDate, day]));

    for (const offer of visibleOffers) {
        const shift = shiftIndex.get(offer.shiftId)!;
        const day = dayIndex.get(shift.operationalDate);
        const lane = shift.shiftLabel === "SN" ? "SN" : "SD";
        if (!day) continue;
        day.offers[lane].push({
            id: offer.id,
            shiftId: offer.shiftId,
            operationalDate: shift.operationalDate,
            shiftLabel: shift.shiftLabel,
            domain: shift.domain,
            targetLabel: targetLabel(shift),
            offeredByDoctorId: offer.offeredByDoctorId,
            offeredByDoctorName: doctorNames.get(offer.offeredByDoctorId) ?? "?",
            bonusBrl: offer.bonusBrl,
            bonusIcons: bonusIcons(offer.bonusBrl),
            note: offer.note,
            status: offer.status,
            settledSwapId: offer.settledSwapId,
            bids: bidsByOffer.get(offer.id) ?? [],
        });
    }

    return board;
}

export async function createOffer(params: {
    shiftId: string;
    bonusBrl: number;
    note?: string | null;
    actorDoctorId: string;
    actorUserId: string;
}) {
    const db = getDb();
    if (params.bonusBrl < 0 || params.bonusBrl > 5000 || params.bonusBrl % 100 !== 0) {
        throw new Error("Bônus deve ser múltiplo de R$100 (até R$5.000).");
    }

    const coverage = await effectiveShiftOwner(params.shiftId);
    if (coverage.effectiveDoctorId !== params.actorDoctorId) {
        throw new Error("Só o dono efetivo atual do plantão pode ofertá-lo no mural.");
    }

    const existing = await db.query.shiftOffers.findFirst({
        where: and(eq(shiftOffers.shiftId, params.shiftId), eq(shiftOffers.status, "open")),
    });
    if (existing) {
        throw new Error("Este plantão já está ofertado no mural.");
    }

    const [created] = await db.insert(shiftOffers).values({
        shiftId: params.shiftId,
        offeredByDoctorId: params.actorDoctorId,
        bonusBrl: params.bonusBrl,
        note: params.note ?? null,
        createdByUserId: params.actorUserId,
    }).returning();

    return created;
}

export async function withdrawOffer(offerId: string, actorDoctorId: string) {
    const db = getDb();
    const [updated] = await db.update(shiftOffers)
        .set({ status: "withdrawn", updatedAt: new Date() })
        .where(and(
            eq(shiftOffers.id, offerId),
            eq(shiftOffers.offeredByDoctorId, actorDoctorId),
            eq(shiftOffers.status, "open"),
        ))
        .returning();
    if (!updated) {
        throw new Error("Oferta não encontrada, já fechada, ou não é sua.");
    }
    return updated;
}

export async function placeBid(params: {
    offerId: string;
    kind: "take" | "counter";
    counterShiftId?: string | null;
    note?: string | null;
    actorDoctorId: string;
    actorUserId: string;
}) {
    const db = getDb();
    const offer = await db.query.shiftOffers.findFirst({ where: eq(shiftOffers.id, params.offerId) });
    if (!offer || offer.status !== "open") {
        throw new Error("Oferta não está mais aberta.");
    }
    if (offer.offeredByDoctorId === params.actorDoctorId) {
        throw new Error("Você não pode dar lance na própria oferta.");
    }

    const shift = await db.query.scheduledShifts.findFirst({ where: eq(scheduledShifts.id, offer.shiftId) });
    const bidder = await db.query.doctors.findFirst({ where: eq(doctors.id, params.actorDoctorId) });
    if (!shift || !bidder) {
        throw new Error("Plantão ou médico não encontrado.");
    }
    if (shift.domain === "regulation" && !bidder.eligibleRegulation) {
        throw new Error("Você não está apto(a) a REGULAÇÃO para pegar este plantão.");
    }
    if (shift.domain === "intervention" && !bidder.eligibleIntervention) {
        throw new Error("Você não está apto(a) a INTERVENÇÃO para pegar este plantão.");
    }

    if (params.kind === "counter") {
        if (!params.counterShiftId) {
            throw new Error("Contra-oferta exige indicar qual plantão seu entra na troca.");
        }
        const counterCoverage = await effectiveShiftOwner(params.counterShiftId);
        if (counterCoverage.effectiveDoctorId !== params.actorDoctorId) {
            throw new Error("O plantão da contra-oferta não é seu (dono efetivo).");
        }
    }

    const [created] = await db.insert(shiftOfferBids).values({
        offerId: params.offerId,
        doctorId: params.actorDoctorId,
        kind: params.kind,
        counterShiftId: params.kind === "counter" ? params.counterShiftId : null,
        note: params.note ?? null,
        createdByUserId: params.actorUserId,
    }).returning();

    return created;
}

/**
 * O ofertante escolhe um lance: nasce o shift_swap já ACEITO pelas duas
 * partes (ofertar + dar lance = consentimento mútuo), aguardando só a
 * chefia aprovar. Os demais lances são recusados e a oferta fecha.
 */
export async function chooseBid(params: { offerId: string; bidId: string; actorDoctorId: string; actorUserId: string }) {
    const db = getDb();
    const offer = await db.query.shiftOffers.findFirst({ where: eq(shiftOffers.id, params.offerId) });
    if (!offer || offer.status !== "open") {
        throw new Error("Oferta não está mais aberta.");
    }
    if (offer.offeredByDoctorId !== params.actorDoctorId) {
        throw new Error("Só quem ofertou pode escolher o lance.");
    }

    const bid = await db.query.shiftOfferBids.findFirst({
        where: and(eq(shiftOfferBids.id, params.bidId), eq(shiftOfferBids.offerId, params.offerId)),
    });
    if (!bid || bid.status !== "pending") {
        throw new Error("Lance não encontrado ou não está mais pendente.");
    }

    const now = new Date();
    return db.transaction(async (tx) => {
        const [swap] = await tx.insert(shiftSwaps).values({
            shiftId: offer.shiftId,
            swapType: bid.kind === "counter" ? "mutual" : "transfer",
            fromDoctorId: offer.offeredByDoctorId,
            toDoctorId: bid.doctorId,
            counterpartShiftId: bid.kind === "counter" ? bid.counterShiftId : null,
            status: "accepted",
            offeredAt: offer.createdAt,
            acceptedAt: now,
            notes: [offer.note, bid.note].filter(Boolean).join(" | ") || null,
            createdByUserId: params.actorUserId,
        }).returning();

        await tx.update(shiftOfferBids)
            .set({ status: "chosen", updatedAt: now })
            .where(eq(shiftOfferBids.id, bid.id));
        await tx.update(shiftOfferBids)
            .set({ status: "declined", updatedAt: now })
            .where(and(eq(shiftOfferBids.offerId, offer.id), eq(shiftOfferBids.status, "pending")));
        await tx.update(shiftOffers)
            .set({ status: "committed", settledSwapId: swap.id, updatedAt: now })
            .where(eq(shiftOffers.id, offer.id));

        return swap;
    });
}

/** Plantões futuros do médico (donos efetivos), para ofertar/contra-ofertar. */
export async function listOfferableShifts(doctorId: string, fromDate: string) {
    const db = getDb();
    const rows = await db.select().from(scheduledShifts).where(and(
        eq(scheduledShifts.status, "planned"),
        gte(scheduledShifts.operationalDate, fromDate),
    )).orderBy(asc(scheduledShifts.operationalDate));

    const results = [];
    for (const row of rows) {
        const coverage = await effectiveShiftOwner(row.id);
        if (coverage.effectiveDoctorId === doctorId) {
            results.push(row);
        }
    }
    return results;
}
