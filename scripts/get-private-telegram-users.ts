#!/usr/bin/env node
/**
 * Query latest private Telegram users who messaged the bot
 * Usage: node --import tsx scripts/get-private-telegram-users.ts [limit]
 */

import { getDb, closeDb } from "../db/index";
import { sql } from "drizzle-orm";

async function getPrivateTelegramUsers(limit: number = 50) {
    const db = getDb();

    try {
        const result = await db.execute(sql`
            SELECT DISTINCT
                sender_telegram_id,
                sender_name,
                MAX(created_at) AS last_message_at,
                COUNT(*) AS total_messages
            FROM operations_v2.telegram_ingested_messages
            WHERE 
                chat_id ~ '^[0-9]+$'
                AND sender_telegram_id IS NOT NULL
                AND sender_name IS NOT NULL
            GROUP BY sender_telegram_id, sender_name
            ORDER BY MAX(created_at) DESC
            LIMIT ${limit}
        `);

        const users = (result as any[]).map((row) => ({
            telegramId: row.sender_telegram_id,
            name: row.sender_name,
            lastMessageAt: new Date(row.last_message_at),
            totalMessages: parseInt(row.total_messages, 10),
        }));

        return users;
    } finally {
        await closeDb();
    }
}

async function main() {
    const limitArg = process.argv[2];
    const limit = limitArg ? parseInt(limitArg, 10) : 50;

    if (!Number.isFinite(limit) || limit < 1) {
        console.error("Invalid limit. Usage: tsx scripts/get-private-telegram-users.ts [limit]");
        process.exit(1);
    }

    console.log(`\n📊 Últimos ${limit} usuários em privado com o bot:\n`);

    try {
        const users = await getPrivateTelegramUsers(limit);

        if (users.length === 0) {
            console.log("❌ Nenhum usuário encontrado.");
            process.exit(0);
        }

        // Tabela formatada
        console.log(
            "┌─────────────────┬──────────────────────────┬─────────────────────────┬─────────────┐"
        );
        console.log(
            "│ Telegram ID     │ Nome                     │ Última mensagem         │ Total msgs  │"
        );
        console.log(
            "├─────────────────┼──────────────────────────┼─────────────────────────┼─────────────┤"
        );

        users.forEach((user) => {
            const telegramId = user.telegramId.padEnd(15);
            const name = (user.name || "(sem nome)").substring(0, 24).padEnd(24);
            const lastAt = new Date(user.lastMessageAt)
                .toISOString()
                .replace("T", " ")
                .substring(0, 19)
                .padEnd(23);
            const totalMsgs = String(user.totalMessages).padStart(11);

            console.log(`│ ${telegramId} │ ${name} │ ${lastAt} │ ${totalMsgs} │`);
        });

        console.log(
            "└─────────────────┴──────────────────────────┴─────────────────────────┴─────────────┘"
        );

        // JSON output
        console.log("\n📋 JSON para análise:\n");
        console.log(JSON.stringify(users, null, 2));
    } catch (error) {
        console.error("❌ Erro ao consultar banco:", error);
        process.exit(1);
    }
}

main();
