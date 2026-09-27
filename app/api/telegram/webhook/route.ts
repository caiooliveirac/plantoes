import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { hasDatabaseUrl } from "@/db";
import { assertSingleRuntimeConfig, logRuntimeIdentity } from "@/lib/runtime-identity";
import { getTelegramWebhookSecret } from "@/modules/telegram/config";
import { processTelegramUpdate } from "@/modules/telegram/service";

function secretConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
    logRuntimeIdentity("api.telegram.webhook");
    assertSingleRuntimeConfig("api.telegram.webhook");

    // Falha fechada: sem TELEGRAM_WEBHOOK_SECRET o webhook não aceita nada —
    // endpoint que grava no banco não fica aberto por esquecimento de config.
    const expectedSecret = getTelegramWebhookSecret();
    if (!expectedSecret) {
        console.error("[tg-hook] TELEGRAM_WEBHOOK_SECRET ausente; webhook recusado (503).");
        return NextResponse.json({ error: "Webhook not configured." }, { status: 503 });
    }
    if (!secretConfere(request.headers.get("x-telegram-bot-api-secret-token"), expectedSecret)) {
        return NextResponse.json({ error: "Invalid Telegram webhook secret." }, { status: 401 });
    }

    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const update = await request.json().catch(() => null);
    if (!update) {
        return NextResponse.json({ error: "Invalid Telegram payload." }, { status: 400 });
    }

    try {
        const startedAt = Date.now();
        // lagMs = quanto tempo o update levou do Telegram até chegar aqui; procMs = o
        // que é nosso. Separa "o bot está lento" de "a entrega está lenta".
        const sentAt = update?.message?.date ? update.message.date * 1000 : null;
        const result = await processTelegramUpdate(update);
        // Só a primeira palavra: o resto do texto carrega codinome/nome e não vai para log.
        const command = typeof update?.message?.text === "string" ? update.message.text.trim().split(/\s+/)[0].slice(0, 24) : "";
        console.log(`[tg-hook] procMs=${Date.now() - startedAt} lagMs=${sentAt ? startedAt - sentAt : "?"} cmd=${JSON.stringify(command)}`);
        return NextResponse.json({ ok: true, result });
    } catch (error) {
        // Detalhe só no log: a mensagem de erro pode carregar SQL, nome ou dado interno.
        console.error("[tg-hook] falha ao processar update:", error);
        return NextResponse.json({ error: "Unable to process Telegram update." }, { status: 400 });
    }
}