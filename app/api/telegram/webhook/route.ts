import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { assertSingleRuntimeConfig, logRuntimeIdentity } from "@/lib/runtime-identity";
import { getTelegramWebhookSecret } from "@/modules/telegram/config";
import { processTelegramUpdate } from "@/modules/telegram/service";

export async function POST(request: NextRequest) {
    logRuntimeIdentity("api.telegram.webhook");
    assertSingleRuntimeConfig("api.telegram.webhook");

    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const expectedSecret = getTelegramWebhookSecret();
    const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (expectedSecret && receivedSecret !== expectedSecret) {
        return NextResponse.json({ error: "Invalid Telegram webhook secret." }, { status: 401 });
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
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to process Telegram update." },
            { status: 400 },
        );
    }
}