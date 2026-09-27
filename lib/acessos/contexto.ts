/* ==========================================================================
   Contexto de uma requisição para o monitor de acessos (docs/monitor-acessos.md):
   de onde veio (IP, localização aproximada), de qual aparelho (user-agent), o
   que pediu (método + caminho) e, no quadro, se a aba estava à vista e em uso.

   IP: o Cloudflare fica na frente e manda `cf-connecting-ip` = o cliente. O
   nginx do magalu grava `X-Real-IP $remote_addr`, que é o IP do Cloudflare,
   não o do cliente — por isso x-real-ip é o último recurso (serve no dev/LAB,
   sem Cloudflare). x-forwarded-for entra antes dele porque chamadas internas
   (porteiro → verificar-escala, em 127.0.0.1) só trazem esse cabeçalho.

   Localização: `cf-ipcountry` sempre (IP Geolocation ligado na zona);
   cidade/região/coordenadas só com o Managed Transform "Add visitor location
   headers" ligado no painel do Cloudflare. Sem ele, fica só o país.
   ========================================================================== */

/** Rota da requisição, gravada pelo proxy.ts (Server Components não sabem o caminho). */
export const CABECALHO_ROTA = "x-plantoes-rota";
/** Uso da Mesa, mandado pelo quadro em cada consulta: `v=1;o=12` (visível; 12 s sem mexer). */
export const CABECALHO_USO_MESA = "x-mesa-uso";

export interface GeoAcesso {
    pais?: string;
    cidade?: string;
    regiao?: string;
    codigoRegiao?: string;
    lat?: number;
    lon?: number;
    fuso?: string;
    cep?: string;
}

export interface UsoDaMesa {
    visivel: boolean;
    /** Segundos desde o último toque/clique/tecla na página; null se o quadro não mandou. */
    ociosoSeg: number | null;
}

export interface ContextoRequisicao {
    ip: string | null;
    userAgent: string | null;
    geo: GeoAcesso;
    metodo: string | null;
    caminho: string | null;
    /** Pedido RSC do roteador do Next (navegação no cliente ou router.refresh). */
    rsc: boolean;
    /** Pré-carregamento de link: não é interação de ninguém. */
    prefetch: boolean;
    usoMesa: UsoDaMesa | null;
}

/** "::ffff:1.2.3.4" (IPv4 dentro de IPv6) vira "1.2.3.4"; o resto só perde espaço e zona. */
export function normalizarIp(valor: string | null | undefined): string | null {
    const bruto = valor?.trim().toLowerCase();
    if (!bruto) return null;
    const semZona = bruto.split("%")[0];
    const mapeado = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(semZona);
    if (mapeado) return mapeado[1];
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(semZona) || /^[0-9a-f:]+$/.test(semZona)) return semZona;
    return null;
}

export function ipDoCliente(headers: Headers): string | null {
    return normalizarIp(headers.get("cf-connecting-ip"))
        ?? normalizarIp(headers.get("x-forwarded-for")?.split(",")[0])
        ?? normalizarIp(headers.get("x-real-ip"));
}

/* O Cloudflare manda cidade com acento em UTF-8, e o parser HTTP do Node lê o
   cabeçalho como latin1 ("SÃ£o Paulo"). Redecodifica quando os bytes formam
   UTF-8 válido; senão devolve como veio. */
export function corrigirUtf8(valor: string): string {
    if (!/[\u0080-ÿ]/.test(valor) || /[^\u0000-ÿ]/.test(valor)) return valor;
    const decodificado = Buffer.from(valor, "latin1").toString("utf8");
    return decodificado.includes("�") ? valor : decodificado;
}

function texto(headers: Headers, nome: string, max = 80): string | undefined {
    const valor = headers.get(nome)?.trim();
    return valor ? corrigirUtf8(valor).slice(0, max) : undefined;
}

function numero(headers: Headers, nome: string): number | undefined {
    const valor = Number(headers.get(nome));
    return headers.get(nome) && Number.isFinite(valor) ? valor : undefined;
}

export function geoDoCliente(headers: Headers): GeoAcesso {
    const geo: GeoAcesso = {};
    const pais = texto(headers, "cf-ipcountry", 4)?.toUpperCase();
    // XX = país desconhecido para o Cloudflare. T1 (Tor) fica: é informação.
    if (pais && pais !== "XX") geo.pais = pais;
    const cidade = texto(headers, "cf-ipcity");
    if (cidade) geo.cidade = cidade;
    const regiao = texto(headers, "cf-region");
    if (regiao) geo.regiao = regiao;
    const codigoRegiao = texto(headers, "cf-region-code", 8);
    if (codigoRegiao) geo.codigoRegiao = codigoRegiao;
    const lat = numero(headers, "cf-iplatitude");
    const lon = numero(headers, "cf-iplongitude");
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        geo.lat = lat;
        geo.lon = lon;
    }
    const fuso = texto(headers, "cf-timezone", 48);
    if (fuso) geo.fuso = fuso;
    const cep = texto(headers, "cf-postal-code", 16);
    if (cep) geo.cep = cep;
    return geo;
}

export function lerUsoDaMesa(valor: string | null): UsoDaMesa | null {
    if (!valor) return null;
    const partes = new Map(valor.split(";").map((parte) => {
        const [chave, v] = parte.split("=");
        return [chave?.trim(), v?.trim()] as const;
    }));
    const v = partes.get("v");
    if (v !== "0" && v !== "1") return null;
    const ocioso = Number(partes.get("o"));
    return {
        visivel: v === "1",
        ociosoSeg: partes.has("o") && Number.isFinite(ocioso) && ocioso >= 0 ? Math.round(ocioso) : null,
    };
}

export function lerRota(valor: string | null): { metodo: string | null; caminho: string | null } {
    const [metodo, caminho] = (valor ?? "").trim().split(/\s+/, 2);
    return {
        metodo: metodo && /^[A-Z]{3,7}$/.test(metodo) ? metodo : null,
        caminho: caminho?.startsWith("/") ? caminho.slice(0, 300) : null,
    };
}

export function lerContextoRequisicao(headers: Headers): ContextoRequisicao {
    const { metodo, caminho } = lerRota(headers.get(CABECALHO_ROTA));
    return {
        ip: ipDoCliente(headers),
        userAgent: headers.get("user-agent")?.trim().slice(0, 400) || null,
        geo: geoDoCliente(headers),
        metodo,
        caminho,
        rsc: headers.get("rsc") === "1",
        prefetch: headers.get("next-router-prefetch") === "1" || headers.get("purpose") === "prefetch",
        usoMesa: lerUsoDaMesa(headers.get(CABECALHO_USO_MESA)),
    };
}
