import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, userRoles, users } from "@/db/schema";
import { hashPassword } from "@/services/auth.service";

const bootstrapPassword = process.env.BOOTSTRAP_ACCESS_PASSWORD?.trim();

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
}

if (!bootstrapPassword) {
    throw new Error("BOOTSTRAP_ACCESS_PASSWORD is required.");
}

const provisionPassword = bootstrapPassword;

const ACCOUNTS = [
    {
        name: "Tom",
        email: "tom@samu.local",
        roles: ["chief"] as const,
        doctorName: null,
    },
    {
        name: "Dora",
        email: "dora@samu.local",
        roles: ["chief"] as const,
        doctorName: null,
    },
    {
        name: "Ivan",
        email: "ivan@samu.local",
        roles: ["chief"] as const,
        doctorName: null,
    },
    {
        name: "Caio",
        email: "caio@samu.local",
        roles: ["admin", "chief"] as const,
        doctorName: "Caio Oliveira do Carmo",
    },
] as const;

async function main() {
    const db = getDb();
    const passwordHash = await hashPassword(provisionPassword);

    for (const account of ACCOUNTS) {
        const doctor = account.doctorName
            ? await db.query.doctors.findFirst({ where: eq(doctors.fullName, account.doctorName) })
            : null;

        const existingUser = await db.query.users.findFirst({ where: eq(users.email, account.email) });
        const [user] = existingUser
            ? await db
                .update(users)
                .set({
                    doctorId: doctor?.id ?? existingUser.doctorId,
                    passwordHash,
                    mustChangePassword: true,
                    isActive: true,
                    updatedAt: new Date(),
                })
                .where(eq(users.id, existingUser.id))
                .returning()
            : await db
                .insert(users)
                .values({
                    doctorId: doctor?.id ?? null,
                    email: account.email,
                    passwordHash,
                    mustChangePassword: true,
                    isActive: true,
                })
                .returning();

        for (const role of account.roles) {
            await db.insert(userRoles).values({
                userId: user.id,
                role,
            }).onConflictDoNothing();
        }

        console.log(`${account.name}: ${account.email} (${account.roles.join(", ")})`);
    }
}

main().catch((error) => {
    console.error("[provision-initial-access] failed", error);
    process.exit(1);
});