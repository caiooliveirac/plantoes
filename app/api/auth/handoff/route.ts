import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { doctors } from "@/db/schema";
import { readAuthenticatedSession } from "@/lib/auth/server";
import { criarTokenHandoff, escalaUrl, federacaoConfigurada, ID_ESCALA, ID_PLANTOES } from "@/lib/auth/federacao";

/* Troca de serviço — lado da ORIGEM (daqui para o escala).

   GET /api/auth/handoff?para=samu-salvador: com sessão válida, assina o
   token de 60 s com o e-mail da sessão e o nome normalizado do médico (é o
   que o /sso do escala usa para achar o profissional) e manda o navegador
   para lá. Sem sessão, volta para a home com o painel de login aberto — é
   navegação de clique, não API. */
export async function GET(req: NextRequest) {
    const para = req.nextUrl.searchParams.get("para") ?? "";
    if (!federacaoConfigurada() || para !== ID_ESCALA) {
        return NextResponse.json({ error: "unknown_service" }, { status: 404 });
    }
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });

    const session = await readAuthenticatedSession();
    const base = (process.env.AUTH_URL?.trim() || req.url).replace(/\/+$/, "");
    if (!session) return NextResponse.redirect(new URL("/?entrar=1", base));
    if (session.user.mustChangePassword) return NextResponse.redirect(new URL("/", base));

    let nome: string | undefined;
    let normalizedName: string | undefined;
    if (session.user.doctorId) {
        const [medico] = await getDb()
            .select({ fullName: doctors.fullName, normalizedName: doctors.normalizedName, isActive: doctors.isActive })
            .from(doctors)
            .where(eq(doctors.id, session.user.doctorId))
            .limit(1);
        if (medico?.isActive) {
            nome = medico.fullName;
            normalizedName = medico.normalizedName;
        }
    }
    const token = criarTokenHandoff({ email: session.user.email, origem: ID_PLANTOES, nome, normalizedName }, para);
    return NextResponse.redirect(`${escalaUrl()}/api/auth/sso?token=${encodeURIComponent(token)}`);
}
