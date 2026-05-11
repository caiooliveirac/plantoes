// Regenera snapshots de payment_attestation por uma lista de (operationalDate, shiftLabel).
// Uso: tsx scripts/refresh-payment-snapshots.ts --dates=2026-04-26:SD,2026-05-03:SN,2026-05-05:SD
// Usa --actor=<userId> ou pega o primeiro usuario operational_admin.

import { closeDb, getDb } from "@/db";
import { sql, eq, isNotNull } from "drizzle-orm";
import { users } from "@/db/schema";
import { refreshPaymentAttestationSlot } from "@/services/payment-attestation.service";

function getFlag(name: string): string | null {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function resolveActorUserId(): Promise<string> {
    const provided = getFlag("actor");
    if (provided) return provided;
    const db = getDb();
    const result = await db.execute(sql`
        select id from operations_v2.users
        where 'admin' = any(roles)
        order by created_at asc limit 1
    `);
    const first = (result as any)[0];
    if (!first?.id) throw new Error("No admin user found; pass --actor=<userId>");
    return String(first.id);
}

async function main() {
    const datesArg = getFlag("dates");
    if (!datesArg) throw new Error("Pass --dates=YYYY-MM-DD:SD,YYYY-MM-DD:SN,...");
    const targets = datesArg.split(",").map((s) => s.trim()).filter(Boolean).map((token) => {
        const [date, shift] = token.split(":");
        if (!date || (shift !== "SD" && shift !== "SN")) throw new Error(`Bad token: ${token}`);
        return { operationalDate: `${date}T12:00:00.000Z`, shiftLabel: shift as "SD" | "SN" };
    });

    const actorUserId = await resolveActorUserId();
    console.log(JSON.stringify({ actorUserId, targets }, null, 2));

    for (const target of targets) {
        try {
            const slot = await refreshPaymentAttestationSlot({ ...target, actorUserId });
            console.log(`OK ${target.operationalDate.slice(0,10)} ${target.shiftLabel} → ${slot.id} ${slot.status} (${slot.summary.needsReviewCount} needs_review)`);
        } catch (err) {
            console.error(`FAIL ${target.operationalDate.slice(0,10)} ${target.shiftLabel}:`, (err as Error).message);
        }
    }

    await closeDb();
}

main().catch(async (err) => { console.error(err); await closeDb().catch(() => undefined); process.exitCode = 1; });
