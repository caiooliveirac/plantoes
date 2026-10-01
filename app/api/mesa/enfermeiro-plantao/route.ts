/* ==========================================================================
   Enfermeiro(a) do plantão na Mesa (services/enfermeiro-plantao.service.ts).

   GET    qualquer sessão da Mesa: turno corrente + quem está registrado. Para
          chefia/admin com ?candidatos=1, também os candidatos da escala (id,
          nome, matrícula — nunca e-mail nem telefone no navegador).
   POST   { profissionalId } (da lista) ou { nome } (digitado): registra para
          o turno corrente, substituindo o anterior. Chefia (com a trava da
          2031) ou admin.
   DELETE limpa o turno corrente. Mesma permissão.
   ========================================================================== */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireMesaEscrita, requireMesaSessionForRead } from "@/lib/auth/server";
import { publishBoardUpdate } from "@/lib/board-live";
import { turnoDoMomento } from "@/modules/operational/enfermeiro-plantao";
import {
    EnfermeiroError,
    enfermeiroDoTurno,
    limparEnfermeiro,
    listarEnfermeirosDaEscala,
    registrarEnfermeiro,
    type EnfermeiroRegistrado,
} from "@/services/enfermeiro-plantao.service";

const schema = z.union([
    z.object({ profissionalId: z.string().trim().min(1).max(100) }),
    z.object({ nome: z.string().trim().min(3).max(120) }),
]);

function erroDeAuth(error: unknown) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
}

function semBanco() {
    return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
}

/** O que vai ao navegador: sem e-mail e sem telefone. */
function publico(registro: EnfermeiroRegistrado | null) {
    if (!registro) return null;
    return { nome: registro.nome, profissionalId: registro.profissionalId, registradoEm: registro.registradoEm };
}

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) return semBanco();
    let session;
    try {
        session = await requireMesaSessionForRead();
    } catch (error) {
        return erroDeAuth(error);
    }
    const turno = turnoDoMomento();
    const podeEditar = session.user.roles.some((role) => role === "admin" || role === "chief") && !session.user.mustChangePassword;
    // A lista só vai quando o seletor abre (?candidatos=1); o refresh do quadro pede só o nome.
    const querCandidatos = podeEditar && request.nextUrl.searchParams.get("candidatos") === "1";
    const [enfermeiro, daEscala] = await Promise.all([
        enfermeiroDoTurno(turno),
        querCandidatos ? listarEnfermeirosDaEscala() : Promise.resolve(null),
    ]);
    return NextResponse.json({
        ok: true,
        turno: { data: turno.data, turno: turno.turno },
        enfermeiro: publico(enfermeiro),
        podeEditar,
        ...(querCandidatos ? {
            escalaDisponivel: daEscala !== null,
            candidatos: (daEscala ?? []).map((item) => ({ id: item.id, nome: item.nome, matricula: item.matricula })),
        } : {}),
    }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) return semBanco();
    let session;
    try {
        session = await requireMesaEscrita(["admin", "chief"]);
    } catch (error) {
        return erroDeAuth(error);
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Escolha um enfermeiro(a) da lista ou digite o nome." }, { status: 400 });
    }
    const turno = turnoDoMomento();
    try {
        const registro = await registrarEnfermeiro({
            turno,
            profissionalId: "profissionalId" in parsed.data ? parsed.data.profissionalId : null,
            nome: "nome" in parsed.data ? parsed.data.nome : null,
            userId: session.user.id,
        });
        publishBoardUpdate("enfermeiro-plantao");
        return NextResponse.json({ ok: true, turno: { data: turno.data, turno: turno.turno }, enfermeiro: publico(registro) });
    } catch (error) {
        if (error instanceof EnfermeiroError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error(`[enfermeiro-plantao] registro: ${error instanceof Error ? error.message : String(error)}`);
        return NextResponse.json({ error: "Não foi possível registrar agora. Tente de novo." }, { status: 500 });
    }
}

export async function DELETE() {
    if (!hasDatabaseUrl()) return semBanco();
    try {
        await requireMesaEscrita(["admin", "chief"]);
    } catch (error) {
        return erroDeAuth(error);
    }
    const turno = turnoDoMomento();
    const havia = await limparEnfermeiro(turno);
    if (havia) publishBoardUpdate("enfermeiro-plantao");
    return NextResponse.json({ ok: true, turno: { data: turno.data, turno: turno.turno }, enfermeiro: null });
}
