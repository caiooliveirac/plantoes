/**
 * Porta de identidade do painel do médico (rotas de autoatendimento).
 *
 * Três entradas valem: a sessão do PRÓPRIO médico, o token assinado da folha
 * (link do bot, sem login) e a sessão de admin (coordenador agindo pela tela do
 * médico). Uma única função para não haver duas versões da mesma checagem.
 */
import { readAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import type { AuthenticatedSession } from "@/lib/auth/server";

export interface AcessoPainel {
    autorizado: boolean;
    session: AuthenticatedSession | null;
    isOwnSession: boolean;
    isAdmin: boolean;
}

export async function autorizarPainelDoMedico(params: {
    medicoId: string;
    ano: number;
    mes: number;
    token?: string;
}): Promise<AcessoPainel> {
    const session = await readAuthenticatedSession();
    const isOwnSession = Boolean(session?.user.doctorId && session.user.doctorId === params.medicoId);
    const isAdmin = Boolean(session?.user.roles.includes("admin"));
    const tokenValido = isValidFolhaToken(params.token, {
        medicoId: params.medicoId,
        ano: params.ano,
        mes: params.mes,
    });
    return {
        autorizado: isOwnSession || isAdmin || tokenValido,
        session: session ?? null,
        isOwnSession,
        isAdmin,
    };
}
