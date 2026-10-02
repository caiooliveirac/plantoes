/* ==========================================================================
   Enfermeiro(a) do plantão (migration 0054): quem a chefia registra na Mesa
   para o turno. Regras do turno em modules/operational/enfermeiro-plantao.ts.

   - Lista de candidatos: a escala (GET {ESCALA_API_URL}/api/servicos/enfermeiros,
     header x-esperados-token = ESCALA_API_TOKEN, os mesmos do /api/esperados
     em modules/operational/expected-schedule.ts). Guardada 5 min em memória
     (falha, 1 min). Escala fora do ar: a Mesa ainda aceita nome digitado.
   - Vários enfermeiros(as) ativos por turno (migration 0055): registrar
     acrescenta (a mesma pessoa não duplica); remover marca só a escolhida como
     substituída, limpar marca todas (o histórico é a auditoria).
   - O e-mail de qualquer linha ativa libera o quadro.mnrs.com.br no porteiro
     (services/acessos-portao.service.ts). Nome digitado não tem e-mail: fica
     só na Mesa e no quadro, sem liberar acesso.
   ========================================================================== */
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { enfermeirosPlantao } from "@/db/schema";
import {
    nomeDeExibicao,
    normalizarEmail,
    normalizarEmails,
    turnosDoPortao,
    type TurnoDoEnfermeiro,
} from "@/modules/operational/enfermeiro-plantao";

export interface EnfermeiroDaEscala {
    id: string;
    nome: string;
    matricula: string | null;
    emails: string[];
    telefone: string | null;
}

export interface EnfermeiroRegistrado {
    id: string;
    turnoData: string;
    turno: string;
    profissionalId: string | null;
    nome: string;
    emails: string[];
    telefone: string | null;
    registradoEm: string;
}

const LISTA_VALE_MS = 5 * 60_000;
const FALHA_VALE_MS = 60_000;
const TEMPO_LIMITE_MS = 2_500;

let lista: { ate: number; valor: EnfermeiroDaEscala[] | null } | null = null;

/** Só para os testes. */
export function esquecerListaDeEnfermeiros() {
    lista = null;
}

function textoOuNull(valor: unknown) {
    if (typeof valor !== "string" && typeof valor !== "number") return null;
    const texto = String(valor).trim();
    return texto.length > 0 ? texto : null;
}

/** Enfermeiros(as) da escala; null quando a escala não respondeu (ou não está configurada). Nunca lança. */
export async function listarEnfermeirosDaEscala(agora = Date.now()): Promise<EnfermeiroDaEscala[] | null> {
    if (lista && lista.ate > agora) return lista.valor;
    const base = process.env.ESCALA_API_URL?.trim().replace(/\/+$/, "");
    if (!base) return null;

    let valor: EnfermeiroDaEscala[] | null = null;
    try {
        const headers: Record<string, string> = {};
        const token = process.env.ESCALA_API_TOKEN?.trim();
        if (token) headers["x-esperados-token"] = token;
        const resposta = await fetch(`${base}/api/servicos/enfermeiros`, {
            headers,
            cache: "no-store",
            signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
        });
        if (resposta.ok) {
            const corpo = await resposta.json() as { ok?: unknown; enfermeiros?: unknown };
            if (corpo.ok === true && Array.isArray(corpo.enfermeiros)) {
                valor = corpo.enfermeiros
                    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
                    .map((item) => ({
                        id: textoOuNull(item.id) ?? "",
                        nome: nomeDeExibicao(textoOuNull(item.nome) ?? ""),
                        matricula: textoOuNull(item.matricula),
                        emails: normalizarEmails(Array.isArray(item.emails) ? item.emails : []),
                        telefone: textoOuNull(item.telefone),
                    }))
                    .filter((item) => item.id && item.nome)
                    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
            }
        }
    } catch {
        valor = null;
    }
    lista = { ate: agora + (valor ? LISTA_VALE_MS : FALHA_VALE_MS), valor };
    return valor;
}

function paraRegistrado(linha: typeof enfermeirosPlantao.$inferSelect): EnfermeiroRegistrado {
    return {
        id: linha.id,
        turnoData: linha.turnoData,
        turno: linha.turno,
        profissionalId: linha.profissionalId,
        // linhas gravadas antes da limpeza ainda trazem a anotação da escala
        nome: nomeDeExibicao(linha.nome),
        emails: linha.emails,
        telefone: linha.telefone,
        registradoEm: linha.registradoEm.toISOString(),
    };
}

/** Enfermeiros(as) ativos do turno, na ordem em que foram registrados. */
export async function enfermeirosDoTurno(turno: Pick<TurnoDoEnfermeiro, "data" | "turno">): Promise<EnfermeiroRegistrado[]> {
    const linhas = await getDb()
        .select()
        .from(enfermeirosPlantao)
        .where(and(
            eq(enfermeirosPlantao.turnoData, turno.data),
            eq(enfermeirosPlantao.turno, turno.turno),
            isNull(enfermeirosPlantao.substituidoEm),
        ))
        .orderBy(asc(enfermeirosPlantao.registradoEm));
    return linhas.map(paraRegistrado);
}

export class EnfermeiroError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

/** Acrescenta ao turno: `profissionalId` (da lista da escala) ou `nome` digitado. Quem já está ativo (mesmo id ou mesmo nome) é devolvido sem duplicar. */
export async function registrarEnfermeiro(params: {
    turno: Pick<TurnoDoEnfermeiro, "data" | "turno">;
    profissionalId?: string | null;
    nome?: string | null;
    userId: string;
}): Promise<EnfermeiroRegistrado> {
    let dados: { profissionalId: string | null; nome: string; emails: string[]; telefone: string | null };
    if (params.profissionalId) {
        const daEscala = await listarEnfermeirosDaEscala();
        if (!daEscala) throw new EnfermeiroError(503, "A escala não respondeu. Digite o nome do enfermeiro(a).");
        const achado = daEscala.find((item) => item.id === params.profissionalId);
        if (!achado) throw new EnfermeiroError(404, "Enfermeiro(a) não encontrado(a) na escala.");
        dados = { profissionalId: achado.id, nome: achado.nome, emails: achado.emails, telefone: achado.telefone };
    } else {
        const nome = (params.nome ?? "").replace(/\s+/g, " ").trim();
        if (nome.length < 3) throw new EnfermeiroError(400, "Informe o nome do enfermeiro(a).");
        dados = { profissionalId: null, nome: nome.slice(0, 120), emails: [], telefone: null };
    }

    const linha = await getDb().transaction(async (tx) => {
        // Serializa os registros do turno: dois cliques seguidos não duplicam.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`enfermeiros-plantao:${params.turno.data}:${params.turno.turno}`}))`);
        const ativos = await tx
            .select()
            .from(enfermeirosPlantao)
            .where(and(
                eq(enfermeirosPlantao.turnoData, params.turno.data),
                eq(enfermeirosPlantao.turno, params.turno.turno),
                isNull(enfermeirosPlantao.substituidoEm),
            ));
        const chaveNome = dados.nome.toLocaleLowerCase("pt-BR");
        const jaEsta = ativos.find((item) => dados.profissionalId
            ? item.profissionalId === dados.profissionalId
            : nomeDeExibicao(item.nome).toLocaleLowerCase("pt-BR") === chaveNome);
        if (jaEsta) return jaEsta;
        const [nova] = await tx
            .insert(enfermeirosPlantao)
            .values({
                turnoData: params.turno.data,
                turno: params.turno.turno,
                ...dados,
                registradoPor: params.userId,
            })
            .returning();
        return nova;
    });
    return paraRegistrado(linha);
}

/** Remove do turno (marca como substituído) um enfermeiro(a) pelo id da linha, ou todos sem `id`. true se removeu alguém. */
export async function limparEnfermeiro(turno: Pick<TurnoDoEnfermeiro, "data" | "turno">, id?: string): Promise<boolean> {
    const linhas = await getDb()
        .update(enfermeirosPlantao)
        .set({ substituidoEm: sql`now()` })
        .where(and(
            eq(enfermeirosPlantao.turnoData, turno.data),
            eq(enfermeirosPlantao.turno, turno.turno),
            isNull(enfermeirosPlantao.substituidoEm),
            id ? eq(enfermeirosPlantao.id, id) : undefined,
        ))
        .returning({ id: enfermeirosPlantao.id });
    return linhas.length > 0;
}

/** Portão do quadro: este e-mail é do enfermeiro(a) registrado num turno que vale agora (com as folgas)? Lança em erro de banco. */
export async function emailDeEnfermeiroDoTurno(email: string, agora = new Date()): Promise<boolean> {
    const alvo = normalizarEmail(email);
    if (!alvo) return false;
    const turnos = turnosDoPortao(agora);
    const linhas = await getDb()
        .select({ id: enfermeirosPlantao.id })
        .from(enfermeirosPlantao)
        .where(and(
            isNull(enfermeirosPlantao.substituidoEm),
            or(...turnos.map((t) => and(eq(enfermeirosPlantao.turnoData, t.data), eq(enfermeirosPlantao.turno, t.turno)))),
            sql`${alvo} = any(${enfermeirosPlantao.emails})`,
        ))
        .limit(1);
    return linhas.length > 0;
}
