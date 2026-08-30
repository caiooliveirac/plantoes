import assert from "node:assert/strict";
import test from "node:test";
import {
    buildChecklistKeyAdminNotice,
    buildChecklistKeyAskBaseReply,
    buildChecklistKeyDeliveryReply,
    buildChecklistKeyMissingReply,
    buildChecklistKeyRegulationTargetReply,
    buildChecklistKeyServiceDownReply,
    parseChecklistKeyRequest,
} from "@/modules/telegram/checklist-key-request";
import { listKnownInterventionBaseCodes } from "@/modules/telegram/parser";

const BASES = listKnownInterventionBaseCodes();

test("parseChecklistKeyRequest: /chave com e sem base, em qualquer chat", () => {
    const comBase = parseChecklistKeyRequest("/chave SM01", "group");
    assert.deepEqual(comBase, { via: "command", baseCode: "SM01", sector: "INTERVENTION", unknownTargetToken: null });

    const semBase = parseChecklistKeyRequest("/chave", "group");
    assert.deepEqual(semBase, { via: "command", baseCode: null, sector: null, unknownTargetToken: null });

    const comSufixoBot = parseChecklistKeyRequest("/chave@PlantoesBot PM04", "supergroup");
    assert.equal(comSufixoBot?.baseCode, "PM04");

    const ramal = parseChecklistKeyRequest("/chave 1363", "private");
    assert.equal(ramal?.sector, "REGULATION");
    assert.equal(ramal?.baseCode, "1363");
});

test("parseChecklistKeyRequest: base desconhecida no /chave expõe o token para a resposta didática", () => {
    const parsed = parseChecklistKeyRequest("/chave SM99", "private");
    assert.equal(parsed?.baseCode, null);
    assert.equal(parsed?.unknownTargetToken, "SM99");
});

test("parseChecklistKeyRequest: deep link /start chave só no privado", () => {
    assert.equal(parseChecklistKeyRequest("/start chave", "private")?.via, "start");
    assert.equal(parseChecklistKeyRequest("/start chave", "group"), null);
    assert.equal(parseChecklistKeyRequest("/start", "private"), null, "start sem payload segue para o tutorial");
});

test("parseChecklistKeyRequest: texto livre no privado — frases naturais sobre a chave", () => {
    assert.equal(parseChecklistKeyRequest("chave", "private")?.via, "text");
    assert.equal(parseChecklistKeyRequest("Chave SM01", "private")?.baseCode, "SM01");
    assert.equal(parseChecklistKeyRequest("qual é a chave?", "private")?.via, "text");
    assert.equal(parseChecklistKeyRequest("preciso da chave de hoje", "private")?.via, "text");
    assert.equal(parseChecklistKeyRequest("perdi a chave do checklist", "private")?.via, "text");
});

test("parseChecklistKeyRequest: texto livre NUNCA dispara no grupo nem em conversa comum", () => {
    assert.equal(parseChecklistKeyRequest("chave SM01", "group"), null, "no grupo só /chave");
    assert.equal(parseChecklistKeyRequest("alguém achou uma chave de carro na base?", "private"), null);
    assert.equal(parseChecklistKeyRequest("Vagner Costa PM04 SD 07:00", "private"), null);
    const longa = `a chave ${"x".repeat(200)}`;
    assert.equal(parseChecklistKeyRequest(longa, "private"), null, "frase longa não é pedido");
});

test("buildChecklistKeyDeliveryReply: entrega a chave e ensina a pedir de novo", () => {
    const reply = buildChecklistKeyDeliveryReply({ baseCode: "SM01", key: "1234", identification: { kind: "explicit" } });
    assert.match(reply, /Chave de hoje de \*SM01\*: \*1234\*/);
    assert.match(reply, /checklist\.mnrs\.com\.br\/b\/SM01/);
    assert.match(reply, /\/chave/, "ensina o caminho para a próxima vez");

    const doQuadro = buildChecklistKeyDeliveryReply({
        baseCode: "PM04",
        key: "9876",
        identification: { kind: "board", doctorName: "Ana Souza" },
    });
    assert.match(doQuadro, /Te achei no quadro: \*Ana Souza\* está em \*PM04\*/);
});

test("buildChecklistKeyAskBaseReply: cada motivo tem explicação própria + formato + bases", () => {
    const semMedico = buildChecklistKeyAskBaseReply({ identification: { kind: "no_doctor" }, knownBases: BASES });
    assert.match(semMedico, /Não consegui te reconhecer pelo nome do Telegram/);
    assert.match(semMedico, /\*\/chave SM01\*/, "ensina o formato exato");
    assert.match(semMedico, /GOA/, "lista as bases válidas");

    const foraDoQuadro = buildChecklistKeyAskBaseReply({
        identification: { kind: "no_occupancy", doctorName: "Ana Souza" },
        knownBases: BASES,
    });
    assert.match(foraDoQuadro, /\*Ana Souza\*, não te encontrei em nenhuma base no quadro/);

    const naRegulacao = buildChecklistKeyAskBaseReply({
        identification: { kind: "regulation_occupancy", doctorName: "Ana Souza", ramal: "1363" },
        knownBases: BASES,
    });
    assert.match(naRegulacao, /você está no ramal \*1363\*/);

    const tokenDesconhecido = buildChecklistKeyAskBaseReply({
        identification: { kind: "no_doctor" },
        knownBases: BASES,
        unknownToken: "SM99",
    });
    assert.match(tokenDesconhecido, /Não reconheci \*SM99\* como base/);
});

test("replies de falha dizem o que houve e o próximo passo (nunca recusa seca)", () => {
    const ramal = buildChecklistKeyRegulationTargetReply("1363", BASES);
    assert.match(ramal, /ramal de regulação/);
    assert.match(ramal, /\*\/chave SM01\*/);

    const foraDoAr = buildChecklistKeyServiceDownReply("SM01");
    assert.match(foraDoAr, /não respondeu agora/);
    assert.match(foraDoAr, /avisei a coordenação/i, "a promessa da copy casa com o aviso real ao admin");
    assert.match(foraDoAr, /checklist\.mnrs\.com\.br\/b\/SM01/);

    const semChave = buildChecklistKeyMissingReply("SM01");
    assert.match(semChave, /não há chave de hoje/);
    assert.match(semChave, /verificar o cadastro/);
});

test("buildChecklistKeyAdminNotice: diz quem pediu, qual base e o que o bot respondeu", () => {
    const entregue = buildChecklistKeyAdminNotice({
        senderName: "Ana Telegram",
        senderUsername: "ana_s",
        senderTelegramId: "12345",
        requestText: "chave",
        baseCode: "SM01",
        resolvedDoctorName: "Ana Souza",
        outcome: "delivered",
    });
    assert.match(entregue, /Pedido de chave no privado/);
    assert.match(entregue, /Ana Telegram · @ana_s · id 12345/);
    assert.match(entregue, /Médico no cadastro: Ana Souza/);
    assert.match(entregue, /entreguei a chave de hoje de SM01/);
    assert.match(entregue, /"chave"/);

    const semBase = buildChecklistKeyAdminNotice({
        senderName: null,
        senderUsername: null,
        senderTelegramId: "999",
        requestText: "qual a chave?",
        baseCode: null,
        resolvedDoctorName: null,
        outcome: "asked_base",
    });
    assert.match(semBase, /\(sem nome no Telegram\)/);
    assert.match(semBase, /não reconhecido pelo nome do Telegram/);
    assert.match(semBase, /pedi para a pessoa informar/);

    const foraDoAr = buildChecklistKeyAdminNotice({
        senderName: "Ana Telegram",
        senderUsername: null,
        senderTelegramId: "12345",
        requestText: "/chave SM01",
        baseCode: "SM01",
        resolvedDoctorName: null,
        outcome: "service_down",
    });
    assert.match(foraDoAr, /FORA DO AR/);
});
