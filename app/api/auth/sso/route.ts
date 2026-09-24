import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { userRoles, users } from "@/db/schema";
import { USER_ROLES, type UserRole } from "@/modules/auth/contracts";
import { writeSessionCookie } from "@/lib/auth/server";
import { federacaoConfigurada, lerTokenHandoff } from "@/lib/auth/federacao";
import { destinoInterno } from "@/lib/auth/destino-interno";

/* Troca de serviço — lado do DESTINO (quem vem do escala entra aqui).

   GET /api/auth/sso?token=…: valida o handoff (60 s, aud = "plantoes") e
   procura a conta ATIVA com aquele e-mail que tenha algum papel. Existindo,
   emite a sessão daqui sem senha: a identidade já foi autenticada pelo
   escala. Sem conta = sem acesso, com a frase na tela — quem decide quem
   opera aqui é a chefia, criando/liberando a conta como sempre. */

function base(req: NextRequest): string {
    return (process.env.AUTH_URL?.trim() || req.url).replace(/\/+$/, "");
}

export async function GET(req: NextRequest) {
    if (!federacaoConfigurada()) return NextResponse.json({ error: "federation_not_configured" }, { status: 404 });
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });

    const token = req.nextUrl.searchParams.get("token") ?? "";
    const handoff = token ? lerTokenHandoff(token) : null;
    if (!handoff) return NextResponse.redirect(new URL("/?sso=token-invalido", base(req)));

    const db = getDb();
    const [user] = await db
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .where(eq(users.email, handoff.email))
        .limit(1);
    const roles = user
        ? (await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, user.id)))
              .map((r) => r.role)
              .filter((r): r is UserRole => USER_ROLES.includes(r))
        : [];
    if (!user || !user.isActive || roles.length === 0) {
        console.log(`[sso-escala] ${new Date().toISOString()} sem_acesso ${JSON.stringify({ email: handoff.email, origem: handoff.origem })}`);
        return NextResponse.redirect(new URL("/?sso=sem-acesso", base(req)));
    }

    await writeSessionCookie(user.id);
    console.log(`[sso-escala] ${new Date().toISOString()} ok ${JSON.stringify({ email: handoff.email, origem: handoff.origem })}`);
    // ?proximo=: o portal mnrs.com.br leva direto a /medico, /medico/folha-ponto…
    return NextResponse.redirect(new URL(destinoInterno(req.nextUrl.searchParams.get("proximo")), base(req)));
}
