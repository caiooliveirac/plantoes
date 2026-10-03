/* ==========================================================================
   Portão de turno e limite de lugares (docs/monitor-acessos.md, "Portão de
   turno"). Regras puras; quem consulta banco e age é
   services/acessos-portao.service.ts.

   1. Mesa operacional e Tabela só abrem para quem está de plantão. Admin
      sempre. Na rede do plantão (a faixa da Central) abre para qualquer conta:
      quem acabou de chegar e ainda não declarou a chegada no bot não pode
      ficar sem a Mesa — menos quem registrou a saída há pouco (a conta
      esquecida aberta no PC da Central fecha 10 min depois da saída).
      Fora da Central, só dentro do próprio turno.
   2. A mesma conta em mais de LUGARES_TOLERADOS lugares ao mesmo tempo:
      todas as sessões caem e a senha é trocada (link de redefinição no
      e-mail). Lugar = faixa de rede (/24 IPv4, /64 IPv6); faixas usadas pela
      mesma sessão contam como um lugar só (celular que troca de IP no 4G,
      aparelho que alterna IPv4/IPv6).
   ========================================================================== */
import { JANELA_MS } from "@/modules/acessos/analise";
import { faixaDeRede } from "@/modules/acessos/rede";
import { ehSoInterno } from "@/modules/auth/contracts";

/** Folga antes da chegada registrada e depois da saída: chegar cedo e sair sem registrar são comuns. */
export const FOLGA_ANTES_DO_TURNO_MS = 30 * 60_000;
export const FOLGA_DEPOIS_DO_TURNO_MS = 60 * 60_000;
/** Saída registrada (bot, web ou chefia) é sinal firme: 10 min e a Mesa fecha. */
export const FOLGA_DEPOIS_DA_SAIDA_REGISTRADA_MS = 10 * 60_000;
/** Por quanto tempo uma saída registrada tira a conta da exceção da Central. */
export const SAIU_VALE_MS = 6 * 60 * 60_000;
/** Até 3 lugares ao mesmo tempo (Central, celular, casa); o 4º derruba tudo. */
export const LUGARES_TOLERADOS = 3;
/** "Ao mesmo tempo" = visto nos últimos 5 minutos (a janela do monitor). */
export const JANELA_DE_LUGARES_MS = JANELA_MS;

export type MotivoDoPortao = "admin" | "plantao" | "central" | "enfermeiro" | "observador" | "interno" | "fora_do_plantao";

export interface EntradaDoPortao {
    roles: readonly string[];
    /** Há ocupação do médico da conta cobrindo agora (com as folgas). */
    emTurno: boolean;
    /** O IP está numa faixa da rede do plantão. */
    naCentral: boolean;
    /** O médico da conta registrou saída há pouco e não está em outro turno:
        quem usa a conta dele na Central agora não é ele (esqueceu logado). */
    saiuDoPlantao?: boolean;
    /** Mesa, quadro.mnrs.com.br e Tabela (painel de vagas): o e-mail da conta
        é do enfermeiro(a) que a chefia registrou para o turno na Mesa, da
        lista da escala (com as mesmas folgas). Nome digitado não tem e-mail:
        não libera. Na Mesa ele só lê (escrita exige admin/chief). */
    enfermeiroDoTurno?: boolean;
}

export function decidirPortao(entrada: EntradaDoPortao): { liberado: boolean; motivo: MotivoDoPortao } {
    if (entrada.roles.includes("admin")) return { liberado: true, motivo: "admin" };
    // Só lê (escrita exige admin/chief e ele não passa em POST): fora do plantão e de qualquer lugar.
    if (entrada.roles.includes("observador")) return { liberado: true, motivo: "observador" };
    // Interno(a) do GOA (docs/internos-goa.md): só entra pelo SkyRescue e só lê — de qualquer lugar.
    // Só a conta que é SÓ interno: o papel somado a médico/chefia não fura o portão.
    if (ehSoInterno(entrada.roles)) return { liberado: true, motivo: "interno" };
    if (entrada.emTurno) return { liberado: true, motivo: "plantao" };
    // Chefia trabalha na Central fora da escala (a trava da 2031 limita a escrita).
    const saiu = entrada.saiuDoPlantao && !entrada.roles.includes("chief");
    if (entrada.naCentral && !saiu) return { liberado: true, motivo: "central" };
    if (entrada.enfermeiroDoTurno) return { liberado: true, motivo: "enfermeiro" };
    return { liberado: false, motivo: "fora_do_plantao" };
}

export const MENSAGEM_FORA_DO_PLANTAO =
    "Fora do seu plantão. A Mesa operacional e a Tabela abrem quando a sua chegada estiver registrada no bot, ou num computador da Central. Enfermeiro(a): quando a chefia de plantão declarar você na Mesa.";

// ── Lugares ao mesmo tempo ───────────────────────────────────────────────────
export interface Visto {
    sessaoId: string;
    ip: string;
    em: number;
}

/** Quantos lugares distintos nos últimos JANELA_DE_LUGARES_MS: faixas ligadas por uma mesma sessão são um lugar. */
export function contarLugares(vistos: readonly Visto[], agora: number): { total: number; faixas: string[] } {
    const pai = new Map<string, string>();
    const raiz = (x: string): string => {
        let r = x;
        while (pai.get(r) !== r) r = pai.get(r)!;
        pai.set(x, r);
        return r;
    };
    const unir = (a: string, b: string) => {
        for (const x of [a, b]) if (!pai.has(x)) pai.set(x, x);
        const ra = raiz(a);
        const rb = raiz(b);
        if (ra !== rb) pai.set(ra, rb);
    };
    const faixas = new Set<string>();
    for (const visto of vistos) {
        if (agora - visto.em > JANELA_DE_LUGARES_MS) continue;
        const faixa = `f:${faixaDeRede(visto.ip)}`;
        faixas.add(faixa);
        unir(faixa, `s:${visto.sessaoId}`);
    }
    const lugares = new Set([...faixas].map(raiz));
    return { total: lugares.size, faixas: [...faixas].map((f) => f.slice(2)).sort() };
}
