/* ==========================================================================
   Sessão única via Kairós (provedor de identidade do parque) — SÓ SERVIDOR.

   O Kairós emite o cookie `kairos_sessao` no domínio pai `.mnrs.com.br`, então
   ele chega sozinho aqui. Este módulo pergunta ao Kairós, servidor↔servidor,
   quem é o dono do cookie: POST {KAIROS_URL}/api/sessao/introspeccao, com o
   token de serviço no `Authorization` e o cookie NO CORPO — nunca na URL, que
   entraria no log de acesso do nginx carregando uma sessão inteira.

   As quatro regras de quem consome (kairos/docs/integracao-servicos.md):
     1. `ativa: false` é recusa.
     2. `trocaDeSenhaPendente: true` também é recusa — a pessoa entrou lá com
        senha provisória e ainda não escolheu a dela.
     3. Kairós fora do ar é recusa, não liberação. Falhar aberto transformaria
        a indisponibilidade do Kairós em acesso irrestrito a este app.
     4. A introspecção diz QUEM é; o que a pessoa pode AQUI continua nascendo
        das roles locais — mesma regra que o escala aplicou ao login com a
        senha do plantões: identidade atravessa, perfil não.

   Desligado por padrão: sem KAIROS_URL + KAIROS_SERVICO_TOKEN no ambiente,
   nada disto roda e o login local continua exatamente como era. O token de
   serviço nasce no repo kairos: `pnpm servico:registrar -- --chave plantoes`.
   ========================================================================== */

/** Nome do cookie que o Kairós emite (NOME_COOKIE de lá, declarado uma vez). */
export const KAIROS_SESSION_COOKIE = "kairos_sessao";

const FETCH_TIMEOUT_MS = 5_000;

export function isKairosIntegrationConfigured(): boolean {
    return Boolean(process.env.KAIROS_URL && process.env.KAIROS_SERVICO_TOKEN);
}

export interface KairosPerson {
    id: string;
    nome: string;
    /** Médico importado do cadastro antigo pode não ter e-mail. */
    email: string | null;
    clienteId: string;
}

export type KairosIntrospection =
    | { ok: true; person: KairosPerson; permissions: string[] }
    | {
          ok: false;
          reason: "desligado" | "inativa" | "troca_pendente" | "indisponivel";
      };

function log(evento: string, detalhe: Record<string, unknown> = {}): void {
    // Nunca o cookie, nunca o token: só o evento e ids não sensíveis.
    console.log(`[auth-kairos] ${new Date().toISOString()} ${evento} ${JSON.stringify(detalhe)}`);
}

/**
 * Pergunta ao Kairós quem é o dono do cookie. Nunca lança: recusa e
 * indisponibilidade são respostas, não exceções — quem chama decide o que a
 * tela diz, sem estourar um 500 no meio de uma página.
 */
export async function introspectKairosSession(cookieValue: string): Promise<KairosIntrospection> {
    const baseUrl = process.env.KAIROS_URL?.trim().replace(/\/+$/, "");
    const serviceToken = process.env.KAIROS_SERVICO_TOKEN;
    if (!baseUrl || !serviceToken) {
        return { ok: false, reason: "desligado" };
    }

    let response: Response;
    try {
        response = await fetch(`${baseUrl}/api/sessao/introspeccao`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${serviceToken}`,
            },
            body: JSON.stringify({ cookie: cookieValue }),
            cache: "no-store",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    } catch (erro) {
        log("indisponivel", { erro: erro instanceof Error ? erro.message : String(erro) });
        return { ok: false, reason: "indisponivel" };
    }

    if (response.status === 401) {
        // 401 aqui é o TOKEN DE SERVIÇO errado ou revogado, não o cookie da
        // pessoa. É problema de configuração dos dois lados — barulho no log,
        // recusa na porta.
        log("servico_nao_autenticado", {
            dica: "KAIROS_SERVICO_TOKEN não confere com o cadastrado no Kairós (servico:registrar).",
        });
        return { ok: false, reason: "indisponivel" };
    }
    if (!response.ok) {
        log("indisponivel", { status: response.status });
        return { ok: false, reason: "indisponivel" };
    }

    let body: {
        ativa?: unknown;
        trocaDeSenhaPendente?: unknown;
        pessoa?: {
            id?: unknown;
            nome?: unknown;
            email?: unknown;
            clienteId?: unknown;
        };
        permissoes?: unknown;
    };
    try {
        body = (await response.json()) as typeof body;
    } catch {
        log("indisponivel", { erro: "json_invalido" });
        return { ok: false, reason: "indisponivel" };
    }

    if (typeof body?.ativa !== "boolean") {
        log("indisponivel", { erro: "resposta_sem_formato" });
        return { ok: false, reason: "indisponivel" };
    }
    if (!body.ativa) {
        return { ok: false, reason: "inativa" };
    }
    if (body.trocaDeSenhaPendente === true) {
        // Deixar passar desfaria a trava que o Kairós impõe à senha provisória.
        return { ok: false, reason: "troca_pendente" };
    }

    const pessoa = body.pessoa;
    if (
        !pessoa ||
        typeof pessoa.id !== "string" ||
        typeof pessoa.nome !== "string" ||
        typeof pessoa.clienteId !== "string"
    ) {
        log("indisponivel", { erro: "resposta_sem_formato" });
        return { ok: false, reason: "indisponivel" };
    }

    return {
        ok: true,
        person: {
            id: pessoa.id,
            nome: pessoa.nome,
            email: typeof pessoa.email === "string" ? pessoa.email : null,
            clienteId: pessoa.clienteId,
        },
        permissions: Array.isArray(body.permissoes)
            ? body.permissoes.filter((p): p is string => typeof p === "string")
            : [],
    };
}
