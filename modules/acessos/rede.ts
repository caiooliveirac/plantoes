/* Rede e lugar de um IP para o monitor de acessos.

   "Rede" é a unidade de lugar: IPv4 = o endereço (casa, Central e 4G saem por
   um IP público cada); IPv6 = o prefixo /64 (os aparelhos de uma mesma casa
   dividem o /64, e o endereço final troca sozinho por privacidade).

   Localização por IP é aproximada — vem do Cloudflare, cidade de referência
   do provedor. Operadora de celular às vezes aparece em outra cidade; por isso
   distância sozinha nunca vira alerta forte (modules/acessos/analise.ts). */
import type { GeoAcesso } from "@/lib/acessos/contexto";

export type FamiliaIp = 4 | 6;

export function familiaDoIp(ip: string): FamiliaIp {
    return ip.includes(":") ? 6 : 4;
}

/** Expande "2804:14c:65::1" para os 8 grupos. */
function gruposIpv6(ip: string): string[] | null {
    const [esquerda, direita, ...resto] = ip.split("::");
    if (resto.length > 0) return null;
    const a = esquerda ? esquerda.split(":") : [];
    const b = direita !== undefined ? (direita ? direita.split(":") : []) : [];
    const faltam = 8 - a.length - b.length;
    if (direita === undefined && a.length !== 8) return null;
    if (faltam < 0) return null;
    const grupos = [...a, ...Array(direita === undefined ? 0 : faltam).fill("0"), ...b];
    return grupos.length === 8 ? grupos.map((g) => (g || "0").replace(/^0+(?=.)/, "")) : null;
}

/** Chave de lugar: IPv4 inteiro; IPv6 = /64. */
export function chaveDeRede(ip: string): string {
    if (familiaDoIp(ip) === 4) return ip;
    const grupos = gruposIpv6(ip);
    return grupos ? `${grupos.slice(0, 4).join(":")}::/64` : ip;
}

/** Faixa de endereços: /24 no IPv4, /64 no IPv6. A Central sai por um pool de
    IPs da mesma /24 — cada PC aparece com um IP; a faixa junta todos. */
export function faixaDeRede(ip: string): string {
    if (familiaDoIp(ip) === 6) return ip.includes("/") ? ip : chaveDeRede(ip);
    return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
}

/** Distância em km entre dois pontos (haversine). */
export function distanciaKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
    const rad = (graus: number) => (graus * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Só vale comparar posição quando o Cloudflare deu cidade: sem ela, lat/lon é o centro do país. */
export function temPosicaoDeCidade(geo: GeoAcesso | null | undefined): geo is GeoAcesso & { lat: number; lon: number; cidade: string } {
    return Boolean(geo?.cidade && typeof geo.lat === "number" && typeof geo.lon === "number");
}

export function descreverLocal(geo: GeoAcesso | null | undefined): string | null {
    if (!geo) return null;
    const regiao = geo.codigoRegiao || geo.regiao;
    if (geo.cidade) {
        const uf = regiao && geo.pais === "BR" ? `-${regiao}` : regiao ? `, ${regiao}` : "";
        const pais = geo.pais && geo.pais !== "BR" ? ` (${geo.pais})` : "";
        return `${geo.cidade}${uf}${pais}`;
    }
    if (regiao) return geo.pais && geo.pais !== "BR" ? `${regiao} (${geo.pais})` : regiao;
    if (geo.pais) return geo.pais === "BR" ? "Brasil (cidade não informada)" : `fora do Brasil (${geo.pais})`;
    return null;
}

/* Provedor pelo DNS reverso (PTR): domínio → nome. `servidor` = datacenter,
   nuvem ou VPN comercial — gente comum não navega de lá. Casa o domínio
   inteiro ou como sufixo depois de um ponto ("x.virtua.com.br"), nunca pedaço
   de rótulo ("internet.com.br" não é "net.com.br"). */
const PROVEDORES: Array<{ dominios: string[]; nome: string; servidor?: true }> = [
    { dominios: ["virtua.com.br", "net.com.br", "claro.com.br", "claro.net.br", "netfone.com.br", "embratel.net.br"], nome: "Claro" },
    { dominios: ["telesp.net.br", "vivo.com.br", "vivo.net.br", "gvt.net.br", "gvt.com.br", "telefonica.com.br", "vivozap.com.br"], nome: "Vivo" },
    { dominios: ["oi.com.br", "oi.net.br", "telemar.net.br", "brasiltelecom.net.br", "brt.com.br", "oivelox.com.br"], nome: "Oi" },
    { dominios: ["tim.com.br", "tim.net.br", "timbrasil.com.br", "intelig.net.br"], nome: "TIM" },
    { dominios: ["algartelecom.com.br", "algar.net.br", "ctbc.com.br", "ctbc.net.br"], nome: "Algar" },
    { dominios: ["brisanet.com.br", "brisanet.net.br"], nome: "Brisanet" },
    { dominios: ["desktop.com.br", "desktop.net.br"], nome: "Desktop" },
    { dominios: ["sercomtel.com.br", "sercomtel.net.br"], nome: "Sercomtel" },
    { dominios: ["ligga.com.br", "ligga.net.br", "copeltelecom.com.br"], nome: "Ligga" },
    { dominios: ["unifique.com.br", "unifique.net.br"], nome: "Unifique" },
    { dominios: ["starlinkisp.net", "starlink.com", "spacex.com"], nome: "Starlink" },
    { dominios: ["amazonaws.com"], nome: "Amazon (nuvem)", servidor: true },
    { dominios: ["googleusercontent.com", "1e100.net"], nome: "Google (nuvem)", servidor: true },
    { dominios: ["cloudapp.net", "cloudapp.azure.com"], nome: "Microsoft (nuvem)", servidor: true },
    { dominios: ["digitalocean.com"], nome: "DigitalOcean (nuvem)", servidor: true },
    { dominios: ["ovh.net", "ovh.com", "ovh.ca"], nome: "OVH (nuvem)", servidor: true },
    { dominios: ["your-server.de", "hetzner.com", "hetzner.de"], nome: "Hetzner (nuvem)", servidor: true },
    { dominios: ["linodeusercontent.com", "linode.com", "akamaitechnologies.com"], nome: "Akamai (nuvem)", servidor: true },
    { dominios: ["m247.com", "m247.ro", "datacamp.co.uk", "nordvpn.com", "expressvpn.com", "surfshark.com", "protonvpn.net", "mullvad.net"], nome: "VPN comercial", servidor: true },
];

export interface Provedor {
    nome: string;
    servidor: boolean;
}

export function provedorPorDnsReverso(ptr: string | null | undefined): Provedor | null {
    const nome = ptr?.trim().toLowerCase().replace(/\.$/, "");
    if (!nome) return null;
    for (const provedor of PROVEDORES) {
        if (provedor.dominios.some((dominio) => nome === dominio || nome.endsWith(`.${dominio}`))) {
            return { nome: provedor.nome, servidor: Boolean(provedor.servidor) };
        }
    }
    // Sem mapeamento: o domínio registrável ajuda o humano ("xpto.net.br").
    const partes = nome.split(".");
    const tamanho = /\.(com|net|org|gov|edu)\.br$/.test(nome) ? 3 : 2;
    return partes.length >= tamanho ? { nome: partes.slice(-tamanho).join("."), servidor: false } : null;
}
