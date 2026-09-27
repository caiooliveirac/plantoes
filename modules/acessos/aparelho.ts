/* Aparelho a partir do user-agent, em português, para os relatórios do monitor
   de acessos. Sem dependência: só o que ajuda a distinguir dois aparelhos
   ("celular Android SM-A536E com Chrome 128" × "iPhone com Safari 17"). O
   user-agent é declarado pelo navegador — prova fraca sozinho, forte quando
   combinado com rede e horário. */

export type TipoAparelho = "celular" | "tablet" | "computador" | "programa" | "desconhecido";

export interface Aparelho {
    tipo: TipoAparelho;
    sistema: string | null;
    navegador: string | null;
    /** Modelo quando o navegador ainda o informa (Samsung Internet, Androids antigos). */
    modelo: string | null;
    /** "celular Android com Chrome 128". */
    descricao: string;
}

const PROGRAMAS: Array<[RegExp, string]> = [
    [/^node$/i, "node"],
    [/\bcurl\//i, "curl"],
    [/\bwget\//i, "wget"],
    [/python-requests|python-urllib|aiohttp/i, "Python"],
    [/node-fetch|undici|axios/i, "Node.js"],
    [/go-http-client/i, "Go"],
    [/\bjava\//i, "Java"],
    [/bot\b|crawler|spider/i, "robô"],
];

function versao(ua: string, padrao: RegExp): string | null {
    const achado = padrao.exec(ua);
    return achado?.slice(1).find(Boolean) ?? null;
}

function navegadorDe(ua: string): string | null {
    if (/Instagram/i.test(ua)) return "navegador do Instagram";
    if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "navegador do Facebook";
    if (/WhatsApp/i.test(ua)) return "navegador do WhatsApp";
    const candidatos: Array<[string, RegExp]> = [
        ["Samsung Internet", /SamsungBrowser\/(\d+)/],
        ["Edge", /Edg(?:A|iOS)?\/(\d+)/],
        ["Opera", /OPR\/(\d+)|Opera\/(\d+)/],
        ["Firefox", /Firefox\/(\d+)|FxiOS\/(\d+)/],
        ["Chrome", /CriOS\/(\d+)|Chrome\/(\d+)/],
        ["Safari", /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/],
    ];
    for (const [nome, padrao] of candidatos) {
        if (padrao.test(ua)) {
            const numero = versao(ua, padrao);
            return numero ? `${nome} ${numero}` : nome;
        }
    }
    return null;
}

export function descreverAparelho(userAgent: string | null | undefined): Aparelho {
    const ua = userAgent?.trim() ?? "";
    if (!ua) {
        return { tipo: "desconhecido", sistema: null, navegador: null, modelo: null, descricao: "aparelho não identificado" };
    }
    for (const [padrao, nome] of PROGRAMAS) {
        if (padrao.test(ua)) {
            return { tipo: "programa", sistema: null, navegador: nome, modelo: null, descricao: `programa automático (${nome})` };
        }
    }

    let tipo: TipoAparelho = "desconhecido";
    let sistema: string | null = null;
    let modelo: string | null = null;
    if (/iPhone/.test(ua)) {
        tipo = "celular";
        sistema = "iPhone";
    } else if (/iPad/.test(ua)) {
        tipo = "tablet";
        sistema = "iPad";
    } else if (/Android/.test(ua)) {
        tipo = /Mobile/.test(ua) ? "celular" : "tablet";
        const numero = versao(ua, /Android (\d+)/);
        sistema = numero ? `Android ${numero}` : "Android";
        // Chrome atual congela o modelo em "K"; Samsung Internet e Androids antigos ainda mandam.
        const bruto = /Android [\d.]+; ([^;)]+)/.exec(ua)?.[1]?.replace(/\s*Build\/.*$/, "").trim();
        if (bruto && bruto !== "K" && !/^(wv|mobile|tablet)$/i.test(bruto) && bruto.length <= 40) modelo = bruto;
    } else if (/Windows NT/.test(ua)) {
        tipo = "computador";
        sistema = "Windows";
    } else if (/CrOS/.test(ua)) {
        tipo = "computador";
        sistema = "Chromebook";
    } else if (/Macintosh|Mac OS X/.test(ua)) {
        tipo = "computador";
        sistema = "Mac";
    } else if (/Linux/.test(ua)) {
        tipo = "computador";
        sistema = "Linux";
    }

    const navegador = navegadorDe(ua);
    const base = tipo === "celular"
        ? (sistema === "iPhone" ? "iPhone" : `celular ${sistema ?? ""}`.trim())
        : tipo === "tablet"
            ? (sistema === "iPad" ? "iPad" : `tablet ${sistema ?? ""}`.trim())
            : tipo === "computador"
                ? `computador ${sistema ?? ""}`.trim()
                : "aparelho não identificado";
    const comModelo = modelo ? `${base} ${modelo}` : base;
    return {
        tipo,
        sistema,
        navegador,
        modelo,
        descricao: navegador ? `${comModelo} com ${navegador}` : comModelo,
    };
}
