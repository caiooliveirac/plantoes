import assert from "node:assert/strict";
import test from "node:test";
import {
    buildRegulationRamalAliasNotice,
    isRetiredRegulationRamal,
    resolveOperationalRoleLabel,
    resolveRegulationRamalAlias,
} from "@/modules/operational/roles";
import { buildMealBreakRoster } from "@/modules/telegram/meal-breaks";
import { parseMessage } from "@/modules/telegram/parser";
import { compareTelegramRegulationCodes } from "@/modules/telegram/presentation-order";
import {
    buildHistoricalOperationalPresenceBoardModel,
    buildOperationalSlotPresenceBoardModel,
    buildPaymentAllocationBoardModel,
    type PaymentAllocationRawRow,
    type PaymentAllocationTargetDefinition,
} from "@/services/board.service";

// Ramal eventual (regulation_posts.on_demand, migration 0043 — 4091, hoje 4092
// pela 0056; o 4091 é da ADM e o parser o troca por 4092): não é uma
// posição fixa. Só existe enquanto alguém está nele; vazio, não é vaga em lugar
// nenhum (pagamento, presença por slot, histórico) e fica fora da divisão de
// almoço/jantar por regra fixa, como PIAM/NUCLEO — mas por ser DISP, não por
// ser eventual: remoto (RMT) nos eventuais 2266–2270 participa normalmente.

const SLOT = {
    operationalDate: "2026-09-20T15:00:00.000Z",
    shiftLabel: "SD" as const,
    startedAt: "2026-09-20T10:00:00.000Z",
    endedAt: "2026-09-20T22:00:00.000Z",
    generatedAt: "2026-09-20T23:00:00.000Z",
};

function target(overrides: Partial<PaymentAllocationTargetDefinition> = {}): PaymentAllocationTargetDefinition {
    return {
        domain: "regulation",
        targetId: 1,
        targetCode: "2035",
        targetLabel: "Ramal 2035",
        sortOrder: 180,
        defaultRole: null,
        ...overrides,
    };
}

const ON_DEMAND_TARGET = target({ targetId: 99, targetCode: "4091", targetLabel: "Ramal 4091", sortOrder: 235, onDemand: true });

function row(overrides: Partial<PaymentAllocationRawRow> = {}): PaymentAllocationRawRow {
    return {
        occupancyId: "occ-4091",
        domain: "regulation",
        targetCode: "4091",
        targetLabel: "Ramal 4091",
        doctorId: "doc-1",
        doctorName: "Ana Souza",
        displayName: "Ana",
        startedAt: "2026-09-20T10:05:00.000Z",
        boardStartedAt: "2026-09-20T10:05:00.000Z",
        endedAt: "2026-09-20T22:00:00.000Z",
        actualEndedAt: "2026-09-20T22:00:00.000Z",
        scheduledStartAt: "2026-09-20T10:00:00.000Z",
        scheduledEndAt: "2026-09-20T22:00:00.000Z",
        continuityGroupId: "cg-1",
        shiftLabel: "SD",
        roleLabel: null,
        ramalLabel: "4091",
        earlyDepartureOutcome: null,
        arrivalDelayMinutes: 5,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: 0,
        ruleCode: "ON_TIME_NO_OVERTIME",
        bankHoursExplanation: "ok",
        source: "telegram",
        notes: "Ana Souza 4091 SD 07:05",
        createdAt: "2026-09-20T10:05:00.000Z",
        ...overrides,
    };
}

test("parser reconhece 4092 como ramal de regulação", () => {
    const parsed = parseMessage("Ana Souza 4092 SD 07:00");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "4092");
    assert.equal(parsed.unknownTargetToken ?? null, null);
    assert.equal("ramalAliasFrom" in parsed, false, "sem troca, o campo nem aparece");
});

test("4091 é da ADM: o parser registra no 4092 (DISP) e guarda o ramal digitado", () => {
    for (const text of ["Ana Souza 4091 SD 07:00", "cheguei 4091 Ana Souza", "Ana Souza ramal 4091 SN"]) {
        const parsed = parseMessage(text);
        assert.equal(parsed.sector, "REGULATION", text);
        assert.equal(parsed.baseCode, "4092", text);
        assert.equal(parsed.ramalAliasFrom, "4091", text);
        assert.equal(parsed.unknownTargetToken ?? null, null, text);
        assert.equal(
            resolveOperationalRoleLabel({ domain: "regulation", code: parsed.baseCode!, shiftLabel: parsed.shiftType, roleLabel: parsed.roleFunction }),
            "DISP",
            text,
        );
    }
});

test("aviso do 4091 → 4092 e aposentadoria do 4091 na Mesa", () => {
    assert.equal(resolveRegulationRamalAlias("4091"), "4092");
    assert.equal(resolveRegulationRamalAlias(" 4091 "), "4092");
    assert.equal(resolveRegulationRamalAlias("4092"), "4092");
    assert.equal(resolveRegulationRamalAlias("2266"), "2266");
    assert.equal(isRetiredRegulationRamal("4091"), true);
    assert.equal(isRetiredRegulationRamal("4092"), false);
    assert.equal(isRetiredRegulationRamal("2266"), false);
    assert.equal(isRetiredRegulationRamal(null), false);
    assert.equal(
        buildRegulationRamalAliasNotice("4091", "4092"),
        "O 4091 é da ADM. Registrei você no 4092 como DISP (reforço).",
    );
    assert.equal(buildRegulationRamalAliasNotice(null, "4092"), "");
    assert.equal(buildRegulationRamalAliasNotice("4092", "4092"), "");
});

test("pagamento: ramal eventual vazio não vira linha (nem 'Sem ocupacao identificada')", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [target(), ON_DEMAND_TARGET],
        rawRows: [],
        ...SLOT,
    });
    const codes = board.regulation.map((entry) => entry.targetCode);
    assert.deepEqual(codes, ["2035"], "só o ramal fixo aparece como vaga descoberta");
});

test("pagamento: ramal eventual ocupado é pago como qualquer ramal", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [target(), ON_DEMAND_TARGET],
        rawRows: [row()],
        ...SLOT,
    });
    const line = board.regulation.find((entry) => entry.targetCode === "4091");
    assert.ok(line, "4091 aparece quando alguém ocupou o slot");
    assert.equal(line?.doctorName, "Ana Souza");
    assert.equal(line?.occupancyId, "occ-4091");
});

test("pagamento: mesmo médico no ramal fixo e no eventual — o eventual perde o conflito e some, sem linha vazia", () => {
    // Um médico só recebe um plantão por slot (ADR-006). Quando a alocação mais
    // confiável fica no ramal fixo, o 4091 não pode sobrar como "vaga a revisar".
    const board = buildPaymentAllocationBoardModel({
        targets: [target(), ON_DEMAND_TARGET],
        rawRows: [
            row({ occupancyId: "occ-2035", targetCode: "2035", targetLabel: "Ramal 2035", ramalLabel: "2035", notes: "Ana Souza 2035 SD 07:05" }),
            row({ startedAt: "2026-09-20T10:06:00.000Z", boardStartedAt: "2026-09-20T10:06:00.000Z", continuityGroupId: "cg-2" }),
        ],
        ...SLOT,
    });
    const rows4091 = board.regulation.filter((entry) => entry.targetCode === "4091");
    const paidFor4091 = rows4091.filter((entry) => entry.occupancyId);
    // Ou o 4091 ficou com uma ocupação real, ou não existe linha nenhuma dele.
    assert.equal(rows4091.length, paidFor4091.length, "nenhuma linha vazia de 4091 pode sobrar");
    const anaRows = board.regulation.filter((entry) => entry.doctorId === "doc-1" && entry.occupancyId);
    assert.equal(anaRows.length, 1, "Ana é paga uma única vez no slot");
});

test("presença por slot e histórico: ramal eventual vazio não conta como furo", () => {
    const presence = buildOperationalSlotPresenceBoardModel({
        targets: [target(), ON_DEMAND_TARGET],
        rawRows: [],
        ...SLOT,
    });
    assert.deepEqual(presence.regulation.map((entry) => entry.targetCode), ["2035"]);
    assert.equal(presence.summary.totalTargets, 1);
    assert.equal(presence.summary.emptyCount, 1);

    const history = buildHistoricalOperationalPresenceBoardModel({
        targets: [target(), ON_DEMAND_TARGET],
        rawRows: [],
        ...SLOT,
    });
    assert.deepEqual(history.regulation.map((entry) => entry.targetCode), ["2035"]);

    const occupied = buildOperationalSlotPresenceBoardModel({
        targets: [target(), ON_DEMAND_TARGET],
        rawRows: [row()],
        ...SLOT,
    });
    assert.ok(occupied.regulation.some((entry) => entry.targetCode === "4091"), "com médico, o 4091 entra na presença do slot");
});

type Board = Parameters<typeof buildMealBreakRoster>[0];

function regulationRow(params: { postId: number; postCode: string; name: string; onDemand?: boolean; roleLabel?: string | null }): Board["regulation"][number] {
    return {
        postId: params.postId,
        occupancyId: `reg-${params.postCode}`,
        postCode: params.postCode,
        postLabel: params.postCode,
        defaultRole: null,
        onDemand: params.onDemand,
        doctorId: `doc-${params.postCode}`,
        doctorName: params.name,
        displayName: params.name,
        startedAt: "2026-09-21T10:00:00.000Z",
        boardStartedAt: "2026-09-21T10:00:00.000Z",
        scheduledEndAt: "2026-09-21T22:00:00.000Z",
        shiftLabel: "SD",
        roleLabel: params.roleLabel ?? null,
        ramalLabel: params.postCode,
        status: "active",
        liveSource: "operations_v2",
        liveUpdatedAt: null,
    };
}

test("divisão de almoço: DISP (4091) fica fora do roster, como PIAM/NUCLEO", () => {
    const board: Board = {
        generatedAt: "2026-09-21T12:00:00.000Z",
        regulation: [
            regulationRow({ postId: 1, postCode: "2035", name: "Renata Lima" }),
            regulationRow({ postId: 2, postCode: "2033", name: "Bia Nunes" }),
            regulationRow({ postId: 99, postCode: "4091", name: "Reforco Eventual", onDemand: true }),
            regulationRow({ postId: 4, postCode: "PIAM", name: "Paula Piam" }),
        ],
        intervention: [],
    };
    // Segunda-feira 21/09/2026, 09:00 SP — turno SD, modo dia.
    const built = buildMealBreakRoster(board, new Date("2026-09-21T09:00:00-03:00"), "day");
    assert.deepEqual(built.roster.map((doctor) => doctor.ramal).sort(), ["2033", "2035"]);
});

test("divisão de almoço: remoto em ramal eventual (2266) participa; DISP não", () => {
    const board: Board = {
        generatedAt: "2026-09-21T12:00:00.000Z",
        regulation: [
            regulationRow({ postId: 1, postCode: "2035", name: "Renata Lima" }),
            regulationRow({ postId: 2, postCode: "2266", name: "Remoto Novo", onDemand: true, roleLabel: "RMT" }),
            regulationRow({ postId: 3, postCode: "2270", name: "Remoto Sem Funcao", onDemand: true }),
            regulationRow({ postId: 99, postCode: "4091", name: "Reforco Eventual", onDemand: true }),
        ],
        intervention: [],
    };
    const built = buildMealBreakRoster(board, new Date("2026-09-21T09:00:00-03:00"), "day");
    assert.deepEqual(built.roster.map((doctor) => doctor.ramal).sort(), ["2035", "2266", "2270"]);
});

test("ordem de apresentação no Telegram: 4091 vem depois dos ramais fixos e antes de PIAM/NUCLEO", () => {
    assert.deepEqual(
        ["NUCLEO", "4091", "1366", "PIAM", "2031", "2154"].sort(compareTelegramRegulationCodes),
        ["2031", "2154", "1366", "4091", "PIAM", "NUCLEO"],
    );
});
