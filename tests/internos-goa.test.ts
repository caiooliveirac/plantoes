import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decidirPortao } from "@/modules/acessos/portao";
import { ehSoInterno, temAcessoAoPlantoes } from "@/modules/auth/contracts";
import { contaVinculadaPode, emailDoInterno, federadoSchema } from "@/modules/auth/internos-goa";

// ── Internos do GOA (docs/internos-goa.md) ───────────────────────────────────
test("interno: abre o app Plantões (o /sso aceita) e é conta só de interno", () => {
    assert.equal(temAcessoAoPlantoes(["interno"]), true);
    assert.equal(ehSoInterno(["interno"]), true);
    assert.equal(ehSoInterno(["interno", "portal"]), true);
    assert.equal(ehSoInterno(["portal"]), false);
    assert.equal(ehSoInterno([]), false);
    assert.equal(ehSoInterno(["interno", "doctor"]), false);
});

test("portão: interno passa fora do plantão e de qualquer lugar", () => {
    assert.deepEqual(decidirPortao({ roles: ["interno"], emTurno: false, naCentral: false }), { liberado: true, motivo: "interno" });
});

test("portão: o papel interno somado a médico não fura o portão de turno", () => {
    assert.deepEqual(decidirPortao({ roles: ["doctor", "interno"], emTurno: false, naCentral: false }), { liberado: false, motivo: "fora_do_plantao" });
});

test("federado: só conta ativa e só interno sai pela via do GOA (teto de privilégio)", () => {
    assert.deepEqual(contaVinculadaPode({ isActive: true, roles: ["interno"] }), { ok: true });
    assert.deepEqual(contaVinculadaPode({ isActive: false, roles: ["interno"] }), { ok: false, motivo: "inactive_account" });
    for (const papel of ["admin", "chief", "doctor", "observador", "enfermeiro"]) {
        assert.deepEqual(contaVinculadaPode({ isActive: true, roles: ["interno", papel] }), { ok: false, motivo: "papel_nao_permitido" }, papel);
    }
});

test("federado: e-mail da conta nova sai do login do GOA, sem acento nem caractere estranho", () => {
    assert.equal(emailDoInterno("joao.silva"), "goa.joao.silva@samu.local");
    assert.equal(emailDoInterno("João Sílva"), "goa.joao.silva@samu.local");
    assert.equal(emailDoInterno("  Ana@@Lima  "), "goa.ana.lima@samu.local");
    assert.equal(emailDoInterno("..."), null);
});

test("federado: pedido aceita só provedor goa e id numérico", () => {
    assert.equal(federadoSchema.safeParse({ provedor: "goa", sujeito: "12", login: "ana" }).success, true);
    assert.equal(federadoSchema.safeParse({ provedor: "escala", sujeito: "12", login: "ana" }).success, false);
    assert.equal(federadoSchema.safeParse({ provedor: "goa", sujeito: "0", login: "ana" }).success, false);
    assert.equal(federadoSchema.safeParse({ provedor: "goa", sujeito: "abc", login: "ana" }).success, false);
    assert.equal(federadoSchema.safeParse({ provedor: "goa", sujeito: "12", login: "" }).success, false);
});

test("interno nunca entra por senha nem escreve na passagem de ocorrências (guarda de código)", () => {
    const auth = readFileSync("services/auth.service.ts", "utf8");
    assert.match(auth, /roles\.length === 0 \|\| ehSoInterno\(todos\)/);
    const passagem = readFileSync("app/api/board/occurrence-handoff/route.ts", "utf8");
    assert.match(passagem, /sessionError\(true\)/);
    assert.match(passagem, /escrita && ehSoInterno/);
});
