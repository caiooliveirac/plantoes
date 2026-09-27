import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { getTelegramWebhookSecret } from "@/modules/telegram/config";
import { POST } from "@/app/api/telegram/webhook/route";

/**
 * Webhook do Telegram: segredo só de TELEGRAM_WEBHOOK_SECRET (nunca AUTH_SECRET,
 * que é a chave HMAC da sessão), falha fechada sem ele, e erro genérico na
 * resposta. Até 2026-09-27 caía para AUTH_SECRET e, sem os dois, aceitava
 * qualquer POST.
 */

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
        saved[key] = process.env[key];
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
    }
    const restore = () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    return Promise.resolve().then(fn).finally(restore);
}

function webhookRequest(secret?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret !== undefined) headers["x-telegram-bot-api-secret-token"] = secret;
    // Corpo inválido: passando do portão, a rota para em 400 (payload) sem tocar no bot.
    return new NextRequest("http://localhost/api/telegram/webhook", { method: "POST", headers, body: "não é json" });
}

test("webhook secret: não cai para AUTH_SECRET", () =>
    withEnv({ TELEGRAM_WEBHOOK_SECRET: undefined, AUTH_SECRET: "chave-da-sessao" }, () => {
        assert.equal(getTelegramWebhookSecret(), "");
    }));

test("webhook secret: vem de TELEGRAM_WEBHOOK_SECRET (trim)", () =>
    withEnv({ TELEGRAM_WEBHOOK_SECRET: "  segredo-tg  ", AUTH_SECRET: "chave-da-sessao" }, () => {
        assert.equal(getTelegramWebhookSecret(), "segredo-tg");
    }));

test("webhook: sem TELEGRAM_WEBHOOK_SECRET responde 503, mesmo mandando o AUTH_SECRET", () =>
    withEnv({ TELEGRAM_WEBHOOK_SECRET: undefined, AUTH_SECRET: "chave-da-sessao" }, async () => {
        for (const header of [undefined, "", "chave-da-sessao"]) {
            const response = await POST(webhookRequest(header));
            assert.equal(response.status, 503, `header=${JSON.stringify(header)}`);
            assert.doesNotMatch(JSON.stringify(await response.json()), /chave-da-sessao/);
        }
    }));

test("webhook: segredo ausente, errado ou de outro tamanho → 401", () =>
    withEnv({ TELEGRAM_WEBHOOK_SECRET: "segredo-tg" }, async () => {
        for (const header of [undefined, "", "segredo-tX", "segredo", "segredo-tg-mais-longo"]) {
            const response = await POST(webhookRequest(header));
            assert.equal(response.status, 401, `header=${JSON.stringify(header)}`);
        }
    }));

test("webhook: segredo certo passa do portão", () =>
    withEnv({ TELEGRAM_WEBHOOK_SECRET: "segredo-tg", DATABASE_URL: process.env.DATABASE_URL ?? "postgres://x@127.0.0.1:1/x" }, async () => {
        const response = await POST(webhookRequest("segredo-tg"));
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: "Invalid Telegram payload." });
    }));

test("webhook: resposta de erro não devolve error.message", () => {
    const source = readFileSync(join(process.cwd(), "app/api/telegram/webhook/route.ts"), "utf8");
    assert.doesNotMatch(source, /error\.message/);
});
