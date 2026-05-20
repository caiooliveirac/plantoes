import { desc, gte } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { telegramIngestedMessages } from "@/db/schema";

// Janela para considerar que uma mensagem seguinte do mesmo remetente foi uma "repetição".
const REPEAT_WINDOW_MS = 25 * 60 * 1000;
const DAYS = Number(process.env.DAYS ?? "30");

type Row = {
    id: string;
    chatId: string;
    senderTelegramId: string | null;
    senderName: string | null;
    rawText: string;
    parsedDomain: string | null;
    parsedTargetCode: string | null;
    parsedAction: string | null;
    status: string;
    resolutionData: unknown;
    errorMessage: string | null;
    createdAt: Date;
};

function isFailureStatus(status: string) {
    // pending_* que exigem ação do usuário contam como "precisou complementar".
    return status === "error"
        || status === "pending_name_selection"
        || status === "pending_departure_justification"
        || status === "pending_departure_correction"
        || status === "pending_batch_confirmation"
        || status === "pending_alerta_confirmation";
}

async function main() {
    const db = getDb();
    const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

    const rows = (await db.select({
        id: telegramIngestedMessages.id,
        chatId: telegramIngestedMessages.chatId,
        senderTelegramId: telegramIngestedMessages.senderTelegramId,
        senderName: telegramIngestedMessages.senderName,
        rawText: telegramIngestedMessages.rawText,
        parsedDomain: telegramIngestedMessages.parsedDomain,
        parsedTargetCode: telegramIngestedMessages.parsedTargetCode,
        parsedAction: telegramIngestedMessages.parsedAction,
        status: telegramIngestedMessages.status,
        resolutionData: telegramIngestedMessages.resolutionData,
        errorMessage: telegramIngestedMessages.errorMessage,
        createdAt: telegramIngestedMessages.createdAt,
    })
        .from(telegramIngestedMessages)
        .where(gte(telegramIngestedMessages.createdAt, since))
        .orderBy(desc(telegramIngestedMessages.createdAt))) as Row[];

    // Agrupa por remetente+chat e ordena cronologicamente.
    const byUser = new Map<string, Row[]>();
    for (const row of rows) {
        const key = `${row.senderTelegramId ?? "?"}:${row.chatId}`;
        if (!byUser.has(key)) byUser.set(key, []);
        byUser.get(key)!.push(row);
    }

    const episodes: Array<{
        sender: string | null;
        chatId: string;
        failure: Row;
        followups: Row[];
        resolved: boolean;
    }> = [];

    for (const [, msgs] of byUser) {
        msgs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i]!;
            if (!isFailureStatus(m.status)) continue;
            // Próximas mensagens do mesmo remetente dentro da janela.
            const followups: Row[] = [];
            let resolved = false;
            for (let j = i + 1; j < msgs.length; j++) {
                const n = msgs[j]!;
                if (n.createdAt.getTime() - m.createdAt.getTime() > REPEAT_WINDOW_MS) break;
                followups.push(n);
                if (n.status === "accepted" || n.status === "ignored") resolved = true;
            }
            if (followups.length > 0) {
                episodes.push({ sender: m.senderName, chatId: m.chatId, failure: m, followups, resolved });
            }
        }
    }

    episodes.sort((a, b) => b.failure.createdAt.getTime() - a.failure.createdAt.getTime());

    const reviewReason = (r: Row) => {
        const d = r.resolutionData as Record<string, unknown> | null;
        if (d && typeof d === "object") {
            return (d.reviewReason ?? d.reviewSummary ?? d.reason ?? null) as string | null;
        }
        return null;
    };

    console.log(`# Episódios de repetição (últimos ${DAYS} dias) — ${episodes.length} total\n`);
    for (const ep of episodes) {
        const f = ep.failure;
        console.log("━".repeat(80));
        console.log(`[${f.createdAt.toISOString()}] ${ep.sender ?? "?"}  chat=${ep.chatId}  resolvido=${ep.resolved ? "sim" : "NÃO"}`);
        console.log(`  FALHA   status=${f.status} domain=${f.parsedDomain ?? "-"} action=${f.parsedAction ?? "-"} target=${f.parsedTargetCode ?? "-"}`);
        console.log(`  texto:  ${JSON.stringify(f.rawText)}`);
        if (f.errorMessage) console.log(`  erro:   ${f.errorMessage}`);
        const rr = reviewReason(f);
        if (rr) console.log(`  motivo: ${rr}`);
        for (const fu of ep.followups) {
            const dt = Math.round((fu.createdAt.getTime() - f.createdAt.getTime()) / 1000);
            console.log(`   └─ +${dt}s [${fu.status}] ${JSON.stringify(fu.rawText)}${fu.errorMessage ? `  (erro: ${fu.errorMessage})` : ""}`);
        }
    }

    await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
