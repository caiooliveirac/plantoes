import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { getTelegramWebhookSecret } from "@/modules/telegram/config";
import { processTelegramUpdate } from "@/modules/telegram/service";

export async function POST(request: NextRequest) {
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
        const result = await processTelegramUpdate(update);
        return NextResponse.json({ ok: true, result });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to process Telegram update." },
            { status: 400 },
        );
    }
}