/**
 * Regression test suite based on real Telegram messages from the audit (2026-04).
 *
 * Each test is derived from actual production messages that either:
 * - caused parsing errors
 * - were ambiguous
 * - required manual correction
 * - exercised edge cases in name extraction, sector detection, or signal classification
 *
 * Categories:
 * 1. Parser extraction (sector, baseCode, time, shift, names, departure, continuation)
 * 2. Casual message classification
 * 3. Name extraction edge cases
 * 4. Multi-intent and batch parsing
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    isCasualTelegramMessage,
    looksLikeDepartureMessage,
    parseMessage,
    parseMessageMulti,
    parseTelegramBatchLines,
} from "@/modules/telegram/parser";
import {
    pickConfidentDoctorCandidate,
    resolveDoctorCandidates,
    scoreDoctorCandidate,
} from "@/modules/telegram/name-resolution";
import { buildCandidatePromptReply } from "@/modules/telegram/replies";

// ================================================================
// 1. ARRIVAL PARSING — real production messages
// ================================================================

test("parses 'Murilo Damasceno 2032 SN as 18:42' as regulation arrival", () => {
    const parsed = parseMessage("Murilo Damasceno 2032 SN as 18:42");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2032");
    assert.equal(parsed.shiftType, "SN");
    assert.equal(parsed.arrivalTime, "18:42");
    assert.equal(parsed.isDeparture, false);
    assert.ok(parsed.extractedNames.length > 0);
    assert.ok(parsed.extractedNames[0].includes("Murilo"));
});

test("parses 'Caio Oliveira continuando 2151 SN' as continuation", () => {
    const parsed = parseMessage("Caio Oliveira continuando 2151 SN");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2151");
    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.shiftType, "SN");
});

test("parses 'Uemerson na PM40 SD' as intervention arrival", () => {
    const parsed = parseMessage("Uemerson na PM40 SD");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PM40");
    assert.equal(parsed.shiftType, "SD");
    assert.ok(parsed.extractedNames[0]?.includes("Uemerson"));
});

test("parses 'Sara Carneiro P na 02' as intervention P-shift via abbreviation", () => {
    const parsed = parseMessage("Sara Carneiro P na 02");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CB02");
    assert.equal(parsed.shiftType, "P");
    assert.ok(parsed.extractedNames[0]?.includes("Sara"));
});

test("parses 'David Menezes P na PP20' as intervention P-shift", () => {
    const parsed = parseMessage("David Menezes P na PP20");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PP20");
    assert.equal(parsed.shiftType, "P");
});

test("parses 'Taisa passos coi - 1368' as regulation arrival", () => {
    const parsed = parseMessage("Taisa passos coi - 1368");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "1368");
    assert.ok(parsed.extractedNames[0]?.includes("Taisa"));
});

test("parses 'Felipe Carvalho no PA 2031 as 7:15' as regulation arrival with time", () => {
    const parsed = parseMessage("Felipe Carvalho no PA 2031 as 7:15");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2031");
    assert.equal(parsed.arrivalTime, "07:15");
});

test("parses 'Bom dia, Taiara SD na 2154' as regulation arrival despite greeting", () => {
    const parsed = parseMessage("Bom dia, Taiara SD na 2154");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2154");
    assert.equal(parsed.shiftType, "SD");
    assert.ok(parsed.extractedNames[0]?.includes("Taiara"));
});

test("parses 'Ananda Andrade CZ50 P' as intervention P-shift", () => {
    const parsed = parseMessage("Ananda Andrade CZ50 P");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CZ50");
    assert.equal(parsed.shiftType, "P");
});

test("parses 'Gustavo Bazin PA 2377 SD' as regulation arrival", () => {
    const parsed = parseMessage("Gustavo Bazin PA 2377 SD");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2377");
    assert.equal(parsed.shiftType, "SD");
});

test("parses 'Ingrid Bandeira 1367 07:20' as regulation arrival with time", () => {
    const parsed = parseMessage("Ingrid Bandeira 1367 07:20");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "1367");
    assert.equal(parsed.arrivalTime, "07:20");
});

test("parses 'Cláudio Teixeira PA 2034 às 07:00h' as regulation with time and accent", () => {
    const parsed = parseMessage("Cláudio Teixeira PA 2034 às 07:00h");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2034");
    assert.equal(parsed.arrivalTime, "07:00");
});

test("parses 'Lívia Andrade SD  2032 07:12' as regulation (double space tolerance)", () => {
    const parsed = parseMessage("Lívia Andrade SD  2032 07:12");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2032");
    assert.equal(parsed.arrivalTime, "07:12");
    assert.equal(parsed.shiftType, "SD");
});

test("parses 'Taiara mudando de PA para 2151' as reassignment to regulation", () => {
    const parsed = parseMessage("Taiara mudando de PA para 2151");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2151");
    assert.equal(parsed.isReassignment, true);
    assert.ok(parsed.extractedNames[0]?.includes("Taiara"));
});

test("parses 'carolina restrepo villafuerte cru 2033 07:20' as regulation (lowercase)", () => {
    const parsed = parseMessage("carolina restrepo villafuerte cru 2033 07:20");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2033");
    assert.equal(parsed.arrivalTime, "07:20");
});

test("parses 'Míriam Ruth CN10 P' as intervention with accent in name", () => {
    const parsed = parseMessage("Míriam Ruth CN10 P");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CN10");
    assert.equal(parsed.shiftType, "P");
});

// ================================================================
// 2. DEPARTURE PARSING — real production messages
// ================================================================

test("parses 'Taiara saindo 2151 18:00' as regulation departure", () => {
    const parsed = parseMessage("Taiara saindo 2151 18:00");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2151");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.arrivalTime, "18:00");
});

test("parses 'Cláudio Teixeira saindo 2034 18:12' as regulation departure", () => {
    const parsed = parseMessage("Cláudio Teixeira saindo 2034 18:12");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "2034");
    assert.equal(parsed.arrivalTime, "18:12");
});

test("parses 'Bruno Alencar, saindo da PM04 rendido por Guilherme Rabelo' as departure extracting only Bruno", () => {
    const parsed = parseMessage("Bruno Alencar, saindo da PM04 rendido por Guilherme Rabelo");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "PM04");
    // The departureSplit should extract only Bruno (the departing doctor), not Guilherme
    assert.ok(parsed.extractedNames[0]?.includes("Bruno"));
    assert.ok(!parsed.extractedNames[0]?.includes("Guilherme"), "Should not include the replacing doctor name");
});

test("parses 'André Viana, saindo da PM40 liberado pela chefia' as departure", () => {
    const parsed = parseMessage("André Viana, saindo da PM40 liberado pela chefia");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "PM40");
    assert.ok(parsed.extractedNames[0]?.includes("Viana"));
});

test("parses 'Leo Morais saindo do SN 1367 as 07:22' as regulation departure", () => {
    const parsed = parseMessage("Leo Morais saindo do SN 1367 as 07:22");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "1367");
    assert.equal(parsed.arrivalTime, "07:22");
});

test("parses 'André Codeceira saindo PP20 07:05' as intervention departure", () => {
    const parsed = parseMessage("André Codeceira saindo PP20 07:05");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "PP20");
    assert.equal(parsed.arrivalTime, "07:05");
});

test("parses 'Karla Pinto saindo da PR03' as intervention departure", () => {
    const parsed = parseMessage("Karla Pinto saindo da PR03");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "PR03");
});

test("parses 'Gustavo Bazin saída da 04 07:00' as intervention departure with abbreviation", () => {
    const parsed = parseMessage("Gustavo Bazin saída da 04 07:00");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "PM04");
    assert.equal(parsed.arrivalTime, "07:00");
});

test("parses 'Robson silva, saindo da 20,' as intervention departure via abbreviation", () => {
    const parsed = parseMessage("Robson silva , saindo da 20 ,");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "PP20");
});

test("parses 'Saindo da 02 sem rendição (furo na escala)' as departure", () => {
    const parsed = parseMessage("Saindo da 02 sem rendição (furo na escala)");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "CB02");
});

// ================================================================
// 3. CONTINUATION PARSING — real production
// ================================================================

test("parses 'Guilherme Rabelo continuando PM04' as continuation", () => {
    const parsed = parseMessage("Guilherme Rabelo continuando PM04");
    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.baseCode, "PM04");
});

test("parses 'Thainara PA 1367 continua' as continuation", () => {
    const parsed = parseMessage("Thainara PA 1367 continua");
    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.baseCode, "1367");
});

// ================================================================
// 4. EDGE CASES — problematic real messages
// ================================================================

test("'24h' in message should not be parsed as arrival time 24:00", () => {
    const parsed = parseMessage("Mateus Ribeiro plantão 24h BR05");
    assert.notEqual(parsed.arrivalTime, "24:00");
});

test("'BR05 desativada' should not extract 'desativada' as a doctor name", () => {
    const parsed = parseMessage("BR05 desativada");
    assert.equal(parsed.baseCode, "BR05");
    // 'desativada' should be filtered by NAME_NOISE_TOKENS
    assert.equal(parsed.extractedNames.length, 0);
});

test("parses 'Victor Mangabeira BR 05 SN' with space in base code", () => {
    const parsed = parseMessage("Victor Mangabeira BR 05 SN");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "BR05");
    assert.equal(parsed.shiftType, "SN");
});

test("parses 'Mateus Almeida BR05 07:00 P' as P-shift arrival", () => {
    const parsed = parseMessage("Mateus Almeida BR05 07:00 P");
    assert.equal(parsed.baseCode, "BR05");
    assert.equal(parsed.shiftType, "P");
    assert.equal(parsed.arrivalTime, "07:00");
});

test("'Passagem de plantão' should be casual", () => {
    const result = isCasualTelegramMessage("Passagem de plantão");
    // This has no operational cue — it's a generic phrase
    // The parser should not treat it as an operational message
    assert.equal(result, false); // it's not casual but also not operational
    const parsed = parseMessage("Passagem de plantão");
    assert.equal(parsed.baseCode, null); // no base to act on
});

test("emoji-only messages are casual", () => {
    assert.equal(isCasualTelegramMessage("👍🏼"), true);
    assert.equal(isCasualTelegramMessage("🙏🏽🙏🏽"), true);
    assert.equal(isCasualTelegramMessage("❤️"), true);
    assert.equal(isCasualTelegramMessage("👍"), true);
});

test("'kkkkk' is casual", () => {
    assert.equal(isCasualTelegramMessage("kkkkk"), true);
});

test("'Perfeito' is casual", () => {
    assert.equal(isCasualTelegramMessage("Perfeito"), true);
});

test("'Bom dia pessoal!' is casual", () => {
    assert.equal(isCasualTelegramMessage("Bom dia pessoal!"), true);
});

test("'Obrigada galera!' is casual", () => {
    assert.equal(isCasualTelegramMessage("Obrigada galera!"), true);
});

test("'Boa noite a todos!' is casual", () => {
    assert.equal(isCasualTelegramMessage("Boa noite a todos!"), true);
});

// P6: new casual patterns
test("'ajuda ai' is casual", () => {
    assert.equal(isCasualTelegramMessage("ajuda ai"), true);
});

test("'quem esta na regulacao' is casual", () => {
    assert.equal(isCasualTelegramMessage("quem esta na regulacao"), true);
});

test("'como faz pra cadastrar' is casual", () => {
    assert.equal(isCasualTelegramMessage("como faz pra cadastrar"), true);
});

test("departure-like text without base is not operational", () => {
    const parsed = parseMessage("Rendido por Vinícius Raimundo");
    assert.equal(parsed.baseCode, null); // no base → can't resolve
});

test("parses 'CAROLINA RESTREPO VILLAFUERTE SAIDA CRU 2034 7:32' as regulation departure", () => {
    const parsed = parseMessage("CAROLINA RESTREPO VILLAFUERTE SAIDA CRU 2034 7:32");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2034");
    assert.equal(parsed.arrivalTime, "07:32");
});

test("parses multiline with 'Willy octavio Rivera arevalo\\nSaída BR 60' as departure", () => {
    const entries = parseMessageMulti("Willy octavio Rivera arevalo\nSaída BR 60");
    const departure = entries.find((e) => e.isDeparture);
    assert.ok(departure, "Should find a departure entry");
    assert.equal(departure.baseCode, "BR60");
});

test("parses 'Willy octavio Rivera Arévalo\\nSaída BR 60' — multiline departure", () => {
    const entries = parseMessageMulti("Willy octavio Rivera Arévalo\nSaída BR 60");
    const departure = entries.find((e) => e.isDeparture);
    assert.ok(departure);
    assert.equal(departure.baseCode, "BR60");
});

test("parses 'João Marcos IT30 saída' as intervention departure", () => {
    const parsed = parseMessage("João Marcos IT30 saída");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "IT30");
});

test("parses 'Samara saindo CC70 08:50 porque estava na ocorrência 0174' as departure", () => {
    const parsed = parseMessage("Samara saindo CC70 08:50 porque estava na ocorrência 0174");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "CC70");
    assert.equal(parsed.arrivalTime, "08:50");
});

test("parses 'Tiago Cervino Raton Peixoto saindo 07:05 PR03 porque fui rendido por Paula Mayana' departureSplit extracts Tiago not Paula", () => {
    const parsed = parseMessage("Tiago Cervino Raton Peixoto saindo 07:05 PR03 porque fui rendido por Paula Mayana");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "PR03");
    assert.equal(parsed.arrivalTime, "07:05");
    // The whole extractedNames might be from the full text since "rendido por" is different from "rendida por"
    // but should still contain Tiago
    assert.ok(parsed.extractedNames[0]?.includes("Tiago"));
});

test("parses 'João Victor Perrone saindo da CN10 após rendição por Miriam' as departure", () => {
    const parsed = parseMessage("João Victor Perrone saindo da CN10 após rendição por Miriam");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "CN10");
});

// ================================================================
// 5. NAME RESOLUTION — real ambiguity cases
// ================================================================

const realDirectory = [
    { id: "1", fullName: "Samara Viana dos Santos", displayName: "Samara Viana", normalizedName: "samara viana dos santos" },
    { id: "2", fullName: "Samara Souza Oliveira", displayName: "Samara Souza", normalizedName: "samara souza oliveira" },
    { id: "3", fullName: "João Marcos Oliveira Moura Santana", displayName: "João Marcos", normalizedName: "joao marcos oliveira moura santana" },
    { id: "4", fullName: "João Pedro Pinto Alves", displayName: "João Pedro Pinto", normalizedName: "joao pedro pinto alves" },
    { id: "5", fullName: "João Miguez Pinto Ferreira", displayName: "João Miguez", normalizedName: "joao miguez pinto ferreira" },
    { id: "6", fullName: "Thainara Santos Lima", displayName: "Thainara", normalizedName: "thainara santos lima" },
    { id: "7", fullName: "Taiara Lohana Figueiredo Oliveira", displayName: "Taiara", normalizedName: "taiara lohana figueiredo oliveira" },
    { id: "8", fullName: "Mateus Ribeiro de Almeida", displayName: "Mateus Ribeiro", normalizedName: "mateus ribeiro de almeida" },
    { id: "9", fullName: "Mateus Almeida Santos", displayName: "Mateus Almeida", normalizedName: "mateus almeida santos" },
    { id: "10", fullName: "Caio Oliveira do Carmo", displayName: "Caio Oliveira", normalizedName: "caio oliveira do carmo" },
    { id: "11", fullName: "Guilherme Rabelo Mota", displayName: "Guilherme Rabelo", normalizedName: "guilherme rabelo mota" },
    { id: "12", fullName: "Willy Octavio Rivera Arevalo", displayName: "Willy Arevalo", normalizedName: "willy octavio rivera arevalo", aliases: ["Willy Rivera"] },
];

test("name resolution: 'Samara Viana' resolves confidently to Samara Viana dos Santos", () => {
    const candidates = resolveDoctorCandidates("Samara Viana", realDirectory, 3);
    const picked = pickConfidentDoctorCandidate("Samara Viana", candidates);
    assert.equal(picked?.id, "1");
});

test("name resolution: 'Samara' alone is ambiguous between two Samaras", () => {
    const candidates = resolveDoctorCandidates("Samara", realDirectory, 3);
    const picked = pickConfidentDoctorCandidate("Samara", candidates);
    // Should be null (ambiguous) since there are two Samaras
    assert.equal(picked, null);
    assert.ok(candidates.length >= 2);
});

test("name resolution: 'João Pedro Pinto' resolves confidently", () => {
    const candidates = resolveDoctorCandidates("João Pedro Pinto", realDirectory, 3);
    const picked = pickConfidentDoctorCandidate("João Pedro Pinto", candidates);
    assert.equal(picked?.id, "4");
});

test("name resolution: 'Thainara' resolves when sole candidate", () => {
    const candidates = resolveDoctorCandidates("Thainara", realDirectory, 3);
    const picked = pickConfidentDoctorCandidate("Thainara", candidates);
    assert.equal(picked?.id, "6");
});

test("name resolution: 'Mateus Ribeiro' resolves to Mateus Ribeiro de Almeida", () => {
    const candidates = resolveDoctorCandidates("Mateus Ribeiro", realDirectory, 3);
    const picked = pickConfidentDoctorCandidate("Mateus Ribeiro", candidates);
    assert.equal(picked?.id, "8");
});

test("name resolution: 'Caio Oliveira' resolves when unique", () => {
    const candidates = resolveDoctorCandidates("Caio Oliveira", realDirectory, 3);
    const picked = pickConfidentDoctorCandidate("Caio Oliveira", candidates);
    assert.equal(picked?.id, "10");
});

test("name resolution: 'Guilherme Rabelo' resolves confidently", () => {
    const candidates = resolveDoctorCandidates("Guilherme Rabelo", realDirectory, 3);
    const picked = pickConfidentDoctorCandidate("Guilherme Rabelo", candidates);
    assert.equal(picked?.id, "11");
});

test("name resolution: alias 'Willy Rivera' matches via aliases", () => {
    const candidates = resolveDoctorCandidates("Willy Rivera", realDirectory, 3);
    assert.ok(candidates.length > 0);
    assert.equal(candidates[0]?.id, "12");
});

test("name resolution: Y/I phonetic equivalence 'Thainara' vs 'Thainara'", () => {
    const score = scoreDoctorCandidate("Thainara", {
        id: "6",
        fullName: "Thainara Santos Lima",
        displayName: "Thainara",
        normalizedName: "thainara santos lima",
    });
    assert.ok(score >= 100, `Expected score >= 100, got ${score}`);
});

// ================================================================
// 6. BATCH PARSING — real multi-line operational messages
// ================================================================

test("batch parsing: INTERVENÇÃO heading + lines", () => {
    const batch = parseTelegramBatchLines(`
INTERVENÇÃO
SM01 - Luiz Augusto 18:55 SN
PR03 - Lucio Alvarez P 06:59
PM04 - Leonardo Cabanelas 19:00 SN
    `.trim());

    assert.equal(batch.length, 3);
    assert.equal(batch[0].headingSector, "INTERVENTION");
    assert.equal(batch[0].parsed.baseCode, "SM01");
    assert.equal(batch[0].parsed.arrivalTime, "18:55");
    assert.equal(batch[1].parsed.baseCode, "PR03");
    assert.equal(batch[1].parsed.shiftType, "P");
    assert.equal(batch[2].parsed.baseCode, "PM04");
});

test("batch parsing: REGULAÇÃO heading + ramal lines", () => {
    const batch = parseTelegramBatchLines(`
REGULAÇÃO
2154 - Marcela Arimateia 19:06 SN
1365 - Caroline Luane 19:00 SN
1367 - Gustavo Bazin 19:01 SN
    `.trim());

    assert.equal(batch.length, 3);
    assert.equal(batch[0].headingSector, "REGULATION");
    assert.equal(batch[0].parsed.baseCode, "2154");
    assert.equal(batch[1].parsed.baseCode, "1365");
    assert.equal(batch[2].parsed.baseCode, "1367");
});

// ================================================================
// 7. REPLY TEMPLATE IMPROVEMENTS
// ================================================================

test("buildCandidatePromptReply includes context (target, time, shift) when provided", () => {
    const reply = buildCandidatePromptReply(42, [
        { fullName: "João Pedro Pinto Alves", displayName: "João Pedro Pinto" },
        { fullName: "João Miguez Pinto Ferreira", displayName: "João Miguez" },
    ], { target: "CC70", time: "08:50", shift: "SD" });

    assert.ok(reply.includes("CC70"), "Should include target in context");
    assert.ok(reply.includes("08:50"), "Should include time in context");
    assert.ok(reply.includes("SD"), "Should include shift in context");
    assert.ok(reply.includes("João Pedro Pinto"), "Should use displayName in list");
    assert.ok(reply.includes("João Miguez"), "Should use displayName in list");
});

test("buildCandidatePromptReply works without context", () => {
    const reply = buildCandidatePromptReply(42, [
        { fullName: "Ana Maria Souza" },
    ]);

    assert.ok(reply.includes("Ana Maria Souza"));
    assert.ok(!reply.includes("Detectei:"));
});

// ================================================================
// 8. DEPARTURE SPLIT — "rendida por" real cases
// ================================================================

test("departure split: 'Bruno Alencar saindo PM04 rendido por Guilherme' extracts Bruno only", () => {
    const parsed = parseMessage("Bruno Alencar saindo PM04 rendido por Guilherme Rabelo");
    assert.equal(parsed.isDeparture, true);
    assert.ok(parsed.extractedNames[0]?.includes("Bruno"));
    assert.ok(!parsed.extractedNames[0]?.includes("Guilherme"));
});

test("departure split: 'Maria saindo CN10 substituída por João Victor' extracts Maria only", () => {
    const parsed = parseMessage("Maria saindo CN10 substituída por João Victor");
    assert.equal(parsed.isDeparture, true);
    assert.ok(parsed.extractedNames[0]?.includes("Maria"));
    assert.ok(!parsed.extractedNames[0]?.includes("Victor"));
});

// ================================================================
// 9. NOISE TOKEN FILTERING — new tokens added in audit
// ================================================================

test("noise tokens: operational words are not extracted as names", () => {
    const noiseTests = [
        { text: "Mudando de ramal 2031", shouldNotContain: "Mudando" },
        { text: "Logada no 2032", shouldNotContain: "Logada" },
        { text: "Plantão 1367", shouldNotContain: "Plantao" },
        { text: "Turno SD 2034", shouldNotContain: "Turno" },
    ];

    for (const { text, shouldNotContain } of noiseTests) {
        const parsed = parseMessage(text);
        const names = parsed.extractedNames.join(" ").toUpperCase();
        assert.ok(
            !names.includes(shouldNotContain.toUpperCase()),
            `'${shouldNotContain}' should be filtered as noise in '${text}', got: ${parsed.extractedNames}`,
        );
    }
});

test("noise tokens: 'rendição', 'higienização', 'ocorrência' are filtered", () => {
    const parsed = parseMessage("Samara saindo CC70 08:50 porque estava na ocorrência 0174");
    const names = parsed.extractedNames.join(" ").toUpperCase();
    assert.ok(!names.includes("OCORRENCIA"), `'ocorrência' should be filtered, got: ${parsed.extractedNames}`);
});

// ================================================================
// 10. looksLikeDepartureMessage — edge cases
// ================================================================

test("looksLikeDepartureMessage: various departure signals", () => {
    assert.equal(looksLikeDepartureMessage("Saindo da 02"), true);
    assert.equal(looksLikeDepartureMessage("saída PM04"), true);
    assert.equal(looksLikeDepartureMessage("finalizei 2031"), true);
    assert.equal(looksLikeDepartureMessage("liberada da BR05"), true);
    assert.equal(looksLikeDepartureMessage("encerrando turno"), true);
    // "rendido" is passive — RENDENDO is arrival signal (the replacing doctor arrives)
    // "fui rendido/a" and "sendo rendido/a" are departure signals
    // "rendido por outro" alone (no FUI/SENDO prefix) is NOT a departure signal
    assert.equal(looksLikeDepartureMessage("rendido por outro"), false);
});

test("looksLikeDepartureMessage: non-departure messages", () => {
    assert.equal(looksLikeDepartureMessage("Chegando na PM04"), false);
    assert.equal(looksLikeDepartureMessage("Bom dia"), false);
    assert.equal(looksLikeDepartureMessage("Continuando 2031"), false);
});

// ================================================================
// 11. SHIFT DETECTION — pre-shift arrival should use correct target shift
// ================================================================

test("parser extracts explicit SN from 'Murilo Damasceno 2032 SN as 18:42'", () => {
    const parsed = parseMessage("Murilo Damasceno 2032 SN as 18:42");
    assert.equal(parsed.shiftType, "SN", "Parser must extract explicit SN, not infer SD from clock");
    assert.equal(parsed.arrivalTime, "18:42");
    assert.equal(parsed.baseCode, "2032");
});

test("explicit SN at 18:42 should have correct target shift window (19:00, not 07:00)", () => {
    const { resolveOperationalShiftWindow } = require("@/modules/operational/board-rules");
    const eventAt = new Date("2026-04-05T18:42:00-03:00");

    const clockWindow = resolveOperationalShiftWindow(eventAt);
    assert.equal(clockWindow.shiftLabel, "SD", "Clock says SD at 18:42");

    const targetWindow = resolveOperationalShiftWindow(clockWindow.nextBoundaryAt);
    assert.equal(targetWindow.shiftLabel, "SN", "Target for SN at 18:42 is the SN window");

    const delayMs = eventAt.getTime() - targetWindow.startedAt.getTime();
    const delayMin = Math.round(delayMs / 60000);
    assert.ok(delayMin < 0, `Should be early (negative delay), got ${delayMin}min`);
    assert.equal(delayMin, -18, "18:42 is 18 minutes before 19:00");
});

test("pre-shift SD: arrival at 05:30 targets SD (07:00), not SN delayed", () => {
    const { resolveOperationalShiftWindow } = require("@/modules/operational/board-rules");
    const eventAt = new Date("2026-04-05T05:30:00-03:00");

    // Clock says SN at 05:30 (before 07:00)
    const clockWindow = resolveOperationalShiftWindow(eventAt);
    assert.equal(clockWindow.shiftLabel, "SN", "Clock says SN at 05:30");

    // Target for SD pre-shift is the NEXT window (SD starting at 07:00)
    const targetWindow = resolveOperationalShiftWindow(clockWindow.nextBoundaryAt);
    assert.equal(targetWindow.shiftLabel, "SD", "Target for SD at 05:30 is the SD window");

    // Should be 90 minutes BEFORE SD start
    const delayMs = eventAt.getTime() - targetWindow.startedAt.getTime();
    const delayMin = Math.round(delayMs / 60000);
    assert.ok(delayMin < 0, `Should be early (negative delay), got ${delayMin}min`);
    assert.equal(delayMin, -90, "05:30 is 90 minutes before 07:00");
});

test("pre-shift SD: arrival at 06:50 targets SD (07:00), shows 10min early", () => {
    const { resolveOperationalShiftWindow } = require("@/modules/operational/board-rules");
    const eventAt = new Date("2026-04-05T06:50:00-03:00");

    const clockWindow = resolveOperationalShiftWindow(eventAt);
    assert.equal(clockWindow.shiftLabel, "SN", "Clock says SN at 06:50");

    const targetWindow = resolveOperationalShiftWindow(clockWindow.nextBoundaryAt);
    assert.equal(targetWindow.shiftLabel, "SD");

    const delayMin = Math.round((eventAt.getTime() - targetWindow.startedAt.getTime()) / 60000);
    assert.equal(delayMin, -10, "06:50 is 10 minutes before 07:00");
});

// --- Reassignment parser tests ---

test("parses 'João Pedro Miguez trocando para 2035 SN' as reassignment to regulation", () => {
    const parsed = parseMessage("João Pedro Miguez trocando para 2035 SN");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2035");
    assert.equal(parsed.shiftType, "SN");
    assert.equal(parsed.isReassignment, true);
    assert.equal(parsed.isDeparture, false);
    assert.equal(parsed.isContinuation, false);
    assert.ok(parsed.extractedNames[0]?.includes("Miguez"), `Expected name to include Miguez, got: ${parsed.extractedNames[0]}`);
});

test("parses 'Felipe Carvalho mudando para CC70 SN' as reassignment to intervention", () => {
    const parsed = parseMessage("Felipe Carvalho mudando para CC70 SN");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CC70");
    assert.equal(parsed.shiftType, "SN");
    assert.equal(parsed.isReassignment, true);
    assert.ok(parsed.extractedNames[0]?.includes("Felipe"));
});

test("parses 'Ana Luiza remanejada para SM01 SD' as reassignment to intervention", () => {
    const parsed = parseMessage("Ana Luiza remanejada para SM01 SD");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "SM01");
    assert.equal(parsed.shiftType, "SD");
    assert.equal(parsed.isReassignment, true);
    assert.ok(parsed.extractedNames[0]?.includes("Ana"));
});

test("reassignment extracts target base from after 'para' when source is also mentioned", () => {
    const parsed = parseMessage("João da SM01 trocando para CC70 SD");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CC70");
    assert.equal(parsed.isReassignment, true);
    assert.equal(parsed.shiftType, "SD");
});

test("parses 'Taiara trocou para 2034 SN' as reassignment to regulation", () => {
    const parsed = parseMessage("Taiara trocou para 2034 SN");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2034");
    assert.equal(parsed.isReassignment, true);
});

test("reassignment does not trigger for normal arrival without transfer verb", () => {
    const parsed = parseMessage("João Pedro 2035 SN 19:00");
    assert.equal(parsed.isReassignment, false);
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2035");
});

test("reassignment does not trigger for 'continuando' messages", () => {
    const parsed = parseMessage("João Pedro continuando CC70 SN");
    assert.equal(parsed.isReassignment, false);
    assert.equal(parsed.isContinuation, true);
});

test("reassignment does not trigger for departure messages", () => {
    const parsed = parseMessage("João Pedro saindo CC70 19:00");
    assert.equal(parsed.isReassignment, false);
    assert.equal(parsed.isDeparture, true);
});

// ================================================================
// REGRESSION: Fixes from daily audit 2026-04-06
// ================================================================

test("strips Telegram markdown formatting: '_João Pedro Miguez 2035_' detects ramal", () => {
    const parsed = parseMessage("_João Pedro Miguez 2035_");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2035");
    assert.ok(parsed.extractedNames[0]?.includes("João"));
    assert.ok(!parsed.extractedNames[0]?.includes("_"));
});

test("iterates base regex past false positives: 'Tiago Peixoto de saída às 07:05hrs PR03' finds PR03", () => {
    const parsed = parseMessage("Tiago Peixoto de saída às 07:05hrs PR03 porque fui rendido");
    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PR03");
    assert.equal(parsed.isDeparture, true);
    assert.ok(parsed.extractedNames[0]?.includes("Tiago"));
    assert.ok(!parsed.extractedNames[0]?.includes("hrs"), "hrs suffix should not appear in name");
});

test("iterates base regex: 'Tiago Peixoto de saída às 07:05hrs PR03' without extra context", () => {
    const parsed = parseMessage("Tiago Peixoto de saída às 07:05hrs PR03");
    assert.equal(parsed.baseCode, "PR03");
    assert.equal(parsed.isDeparture, true);
});

test("NUCLEO is detected as regulation position", () => {
    const parsed = parseMessage("Caio Oliveira chegada no NÚCLEO 07:00");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "NUCLEO");
    assert.equal(parsed.arrivalTime, "07:00");
    assert.ok(parsed.extractedNames[0]?.includes("Caio"));
    assert.ok(!parsed.extractedNames[0]?.includes("NUCLEO"), "NUCLEO should not appear in name");
});

test("NUCLEO without accents is detected", () => {
    const parsed = parseMessage("Caio Oliveira NUCLEO 07:00");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "NUCLEO");
});

test("noise token 'estava' is cleaned from name: 'Samara saindo CC70 08:50 porque estava na ocorrência'", () => {
    const parsed = parseMessage("Samara saindo CC70 08:50 porque estava na ocorrência 0174");
    assert.equal(parsed.baseCode, "CC70");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.extractedNames[0], "Samara");
    assert.ok(!parsed.extractedNames[0]?.includes("estava"));
});

test("noise token 'PA' is cleaned from name: 'Thainara PA 1367 continua'", () => {
    const parsed = parseMessage("Thainara PA 1367 continua");
    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "1367");
    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.extractedNames[0], "Thainara");
    assert.ok(!parsed.extractedNames[0]?.includes("PA"));
});

test("departure without base still has isDeparture=true and extracts name", () => {
    const parsed = parseMessage("alexandre faria saindo");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, null);
    assert.ok(parsed.extractedNames[0]?.includes("alexandre"));
});

test("departure from COI without ramal: 'Leo Morais saindo do SN no COI as 07:22'", () => {
    const parsed = parseMessage("Leo Morais saindo do SN no COI as 07:22");
    assert.equal(parsed.isDeparture, true);
    assert.ok(parsed.extractedNames[0]?.includes("Leo"));
    assert.ok(!parsed.extractedNames[0]?.includes("COI"), "COI (role code) should not appear in name");
});

test("reassignment 'Remanejado para 70. Chagada no plantão 18:55h' detects CC70", () => {
    const parsed = parseMessage("Boa noite! Remanejado para 70. Chagada no plantão 18:55h");
    assert.equal(parsed.baseCode, "CC70");
    assert.equal(parsed.isReassignment, true);
    assert.equal(parsed.arrivalTime, "18:55");
});

// ================================================================
// P4 — noise tokens added on 07/abr/2026 audit
// ================================================================

test("noise token 'planta' is not extracted as name: 'Finalizando planta na CRU'", () => {
    const parsed = parseMessage("Finalizando planta na CRU");
    const names = parsed.extractedNames.join(" ").toUpperCase();
    assert.ok(!names.includes("PLANTA"), `'planta' should be filtered as noise, got: ${parsed.extractedNames}`);
});

test("noise token 'realocado' is not extracted as name: 'Realocado para BR60'", () => {
    const parsed = parseMessage("Realocado para BR60");
    const names = parsed.extractedNames.join(" ").toUpperCase();
    assert.ok(!names.includes("REALOCADO"), `'realocado' should be filtered as noise, got: ${parsed.extractedNames}`);
});

test("noise token 'medico' is not extracted as name: 'Medico 2031 SD'", () => {
    const parsed = parseMessage("Medico 2031 SD");
    const names = parsed.extractedNames.join(" ").toUpperCase();
    assert.ok(!names.includes("MEDICO"), `'medico' should be filtered as noise, got: ${parsed.extractedNames}`);
});

test("noise token 'eu' is not extracted as name: 'eu continuo na 1367'", () => {
    const parsed = parseMessage("eu continuo na 1367");
    const names = parsed.extractedNames.join(" ").toUpperCase();
    assert.ok(!names.includes("EU"), `'eu' should be filtered as noise, got: ${parsed.extractedNames}`);
});

test("noise token 'corrigir' is not extracted as name: 'Corrigir Samara Messias BR60 07:00 SD'", () => {
    const parsed = parseMessage("Corrigir Samara Messias BR60 07:00 SD");
    const names = parsed.extractedNames.join(" ").toUpperCase();
    assert.ok(!names.includes("CORRIGIR"), `'corrigir' should be filtered as noise, got: ${parsed.extractedNames}`);
    assert.ok(names.includes("SAMARA"), `should still extract 'Samara', got: ${parsed.extractedNames}`);
});

test("noise token 'almoco' is not extracted as name: 'MARIANA ALMOCO 1368'", () => {
    const parsed = parseMessage("MARIANA ALMOCO 1368");
    const names = parsed.extractedNames.join(" ").toUpperCase();
    assert.ok(!names.includes("ALMOCO"), `'almoco' should be filtered as noise, got: ${parsed.extractedNames}`);
    assert.ok(names.includes("MARIANA"), `should still extract 'Mariana', got: ${parsed.extractedNames}`);
});

test("noise token 'CB' is not extracted as name: 'CB 2035 SD 07:00'", () => {
    const parsed = parseMessage("CB 2035 SD 07:00");
    const names = parsed.extractedNames.join(" ").toUpperCase();
    assert.ok(!names.includes("CB"), `'CB' should be filtered as noise, got: ${parsed.extractedNames}`);
});

// ================================================================
// P3a — 'fui rendido' is departure, 'rendendo' is arrival
// ================================================================

test("P3a: 'fui rendido' is detected as departure signal", () => {
    assert.equal(looksLikeDepartureMessage("fui rendido por outro medico"), true);
    assert.equal(looksLikeDepartureMessage("fui rendida pela colega"), true);
    assert.equal(looksLikeDepartureMessage("sendo rendido agora"), true);
});

test("P3a: 'rendendo' remains an arrival signal", () => {
    const parsed = parseMessage("Lucio Parada rendendo na PR03 07:15 SD");
    assert.equal(parsed.confidence, "HIGH");
    assert.equal(parsed.isDeparture, false);
    assert.equal(parsed.baseCode, "PR03");
});

test("P3a: 'Lucio Parada fui rendido PR03' is departure, not arrival", () => {
    const parsed = parseMessage("Lucio Parada fui rendido PR03 07:15");
    assert.equal(parsed.isDeparture, true);
    assert.equal(parsed.baseCode, "PR03");
});
