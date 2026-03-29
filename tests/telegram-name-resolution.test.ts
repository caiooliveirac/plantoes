import assert from "node:assert/strict";
import test from "node:test";
import { pickCandidateFromReply, pickConfidentDoctorCandidate, resolveDoctorCandidates } from "@/modules/telegram/name-resolution";
import { buildCandidatePromptReply, buildNameUnresolvedReply, buildTelegramBatchApplyReply, buildTelegramBatchReviewReply, pickTelegramReply } from "@/modules/telegram/replies";

const directory = [
    {
        id: "1",
        fullName: "Ana Maria Souza",
        displayName: "Ana Souza",
        normalizedName: "ana maria souza",
    },
    {
        id: "2",
        fullName: "Ana Marta Sousa",
        displayName: "Ana Marta",
        normalizedName: "ana marta sousa",
    },
    {
        id: "3",
        fullName: "Bruno Lima",
        displayName: "Bruno Lima",
        normalizedName: "bruno lima",
    },
];

test("resolveDoctorCandidates prioritizes exact and token-complete matches", () => {
    const candidates = resolveDoctorCandidates("Ana Souza", directory);

    assert.equal(candidates[0]?.id, "1");
    assert.ok((candidates[0]?.score ?? 0) > (candidates[1]?.score ?? 0));
});

test("pickCandidateFromReply supports numeric follow-up", () => {
    const candidates = resolveDoctorCandidates("Ana", directory, 3);
    const picked = pickCandidateFromReply("2", candidates);

    assert.equal(picked?.id, candidates[1]?.id);
});

test("pickCandidateFromReply stays conservative for frequent ambiguous prefixes", () => {
    const candidates = resolveDoctorCandidates("Ale", [
        {
            id: "10",
            fullName: "Alessandra Almeida",
            displayName: "Alessandra Almeida",
            normalizedName: "alessandra almeida",
        },
        {
            id: "11",
            fullName: "Alexandre Alves",
            displayName: "Alexandre Alves",
            normalizedName: "alexandre alves",
        },
        {
            id: "12",
            fullName: "Alexsandra Araujo",
            displayName: "Alexsandra Araujo",
            normalizedName: "alexsandra araujo",
        },
    ], 3);

    assert.equal(pickCandidateFromReply("Ale", candidates), null);
    assert.equal(pickCandidateFromReply("Alessandra Almeida", candidates)?.id, "10");
});

test("pickConfidentDoctorCandidate accepts a clearly dominant multi-token match", () => {
    const candidates = resolveDoctorCandidates("Ana Luiza", [
        {
            id: "20",
            fullName: "Ana Luiza Andrade Alves",
            displayName: "Ana Alves",
            normalizedName: "ana luiza andrade alves",
        },
        {
            id: "21",
            fullName: "Ana Lucia Andrade",
            displayName: "Ana Lucia",
            normalizedName: "ana lucia andrade",
        },
    ], 2);

    assert.equal(pickConfidentDoctorCandidate("Ana Luiza", candidates)?.id, "20");
});

test("resolveDoctorCandidates keeps inactive exact-prefix matches available as fallback", () => {
    const candidates = resolveDoctorCandidates("Yuri", [
        {
            id: "30",
            fullName: "Yuri Mariano",
            displayName: "Yuri Mariano",
            normalizedName: "YURI MARIANO",
            isActive: false,
        },
    ], 3);

    assert.equal(candidates[0]?.id, "30");
    assert.equal(pickConfidentDoctorCandidate("Yuri", candidates)?.id, "30");
});

test("resolveDoctorCandidates prefers active doctor on score tie", () => {
    const candidates = resolveDoctorCandidates("Ana Souza", [
        {
            id: "40",
            fullName: "Ana Souza",
            displayName: "Ana Souza",
            normalizedName: "ANA SOUZA",
            isActive: false,
        },
        {
            id: "41",
            fullName: "Ana Souza",
            displayName: "Ana Souza",
            normalizedName: "ANA SOUZA",
            isActive: true,
        },
    ], 2);

    assert.equal(candidates[0]?.id, "41");
});

test("pickTelegramReply is deterministic for the same seed", () => {
    const first = pickTelegramReply("arrival_recorded", 1234, {
        name: "Ana Souza",
        target: "2031",
        time: "07:05",
    });
    const second = pickTelegramReply("arrival_recorded", 1234, {
        name: "Ana Souza",
        target: "2031",
        time: "07:05",
    });

    assert.equal(first, second);
    assert.match(first, /Ana Souza/);
});

test("buildCandidatePromptReply lists numbered candidates and asks for redigitacao", () => {
    const reply = buildCandidatePromptReply(77, [
        { fullName: "Ana Maria Souza" },
        { fullName: "Ana Marta Sousa" },
        { fullName: "Ana Paula Souza" },
    ]);

    assert.match(reply, /1\. Ana Maria Souza/);
    assert.match(reply, /Responda com 1, 2 ou 3/);
    assert.match(reply, /redigite nome e sobrenome/i);
});

test("buildNameUnresolvedReply shows suggestions and asks to redigite", () => {
    const reply = buildNameUnresolvedReply(88, [
        { fullName: "Bruno Lima" },
        { fullName: "Bruna Lima" },
    ]);

    assert.match(reply, /Mais próximos/);
    assert.match(reply, /Bruno Lima/);
    assert.match(reply, /redigite o nome/i);
});

test("buildTelegramBatchReviewReply asks for confirmation when all entries are ready", () => {
    const reply = buildTelegramBatchReviewReply({
        entries: [
            {
                lineNumber: 1,
                doctorName: "Felipe Figueiredo de Carvalho",
                targetCode: "2031",
                timeLabel: "07:00",
                sector: "REGULATION",
                mode: "arrival",
            },
            {
                lineNumber: 2,
                doctorName: "Vinicius Santos Moura de Jesus",
                targetCode: "CZ50",
                timeLabel: "continua",
                sector: "INTERVENTION",
                mode: "continuation",
            },
        ],
        issues: [],
    });

    assert.match(reply, /Conferi o lote/);
    assert.match(reply, /2031 - Felipe Figueiredo de Carvalho - 07:00/);
    assert.match(reply, /CZ50 - Vinicius Santos Moura de Jesus - continua/);
    assert.match(reply, /Responda CONFIRMAR/i);
});

test("buildTelegramBatchReviewReply highlights lines that need correction", () => {
    const reply = buildTelegramBatchReviewReply({
        entries: [
            {
                lineNumber: 3,
                doctorName: "Gerardson Macedo e Silva Souza",
                targetCode: "1367",
                timeLabel: "07:11",
                sector: "REGULATION",
                mode: "arrival",
            },
        ],
        issues: [
            {
                lineNumber: 4,
                rawLine: "ANDRE CODECEIRA SOMBRA 07:05",
                reason: "faltou base ou ramal",
            },
        ],
    });

    assert.match(reply, /precisam de correção/i);
    assert.match(reply, /faltou base ou ramal/);
    assert.match(reply, /ANDRE CODECEIRA SOMBRA 07:05/);
    assert.doesNotMatch(reply, /Responda CONFIRMAR/i);
});

test("buildTelegramBatchApplyReply summarizes partial failures", () => {
    const reply = buildTelegramBatchApplyReply({
        appliedCount: 10,
        failed: [
            { lineNumber: 8, reason: "Regulation post not found." },
        ],
    });

    assert.match(reply, /Lancei 10 registros/);
    assert.match(reply, /8\. Regulation post not found\./);
});