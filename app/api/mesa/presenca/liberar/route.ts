import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { contaNaMesa, readAuthenticatedSession } from "@/lib/auth/server";
import { liberarLease } from "@/services/mesa-presenca.service";

/* Aba da Mesa fechada (navigator.sendBeacon no pagehide): solta a vez deste
   aparelho na hora, sem esperar os 45 s. Só solta a vez do próprio aparelho. */
export async function POST() {
    if (!hasDatabaseUrl()) return new NextResponse(null, { status: 204 });
    const session = await readAuthenticatedSession();
    if (!session) return new NextResponse(null, { status: 204 });
    const conta = await contaNaMesa(session);
    if (conta) await liberarLease(conta);
    return new NextResponse(null, { status: 204 });
}
