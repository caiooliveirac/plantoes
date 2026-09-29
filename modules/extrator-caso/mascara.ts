/**
 * Máscara do extrator de caso (docs/extrator-caso.md).
 *
 * Tudo que sai daqui pode ser colado numa sessão de IA fora do servidor. Por
 * isso a regra é de lista branca: nome, e-mail, id, unidade e data civil nunca
 * passam em claro — viram pseudônimo estável (HMAC com segredo do servidor) ou
 * posição relativa ao mês do caso. A legenda que desfaz a troca fica só na tela
 * do admin; não entra no texto copiável.
 *
 * Módulo puro: não toca banco nem ambiente.
 */
import { createHmac } from "node:crypto";
import { bahiaClockHHMM, bahiaDateIso } from "@/lib/time";
import { CHIEF_REGULATION_POST_CODE } from "@/modules/operational/roles";

export type DominioDoAlvo = "regulation" | "intervention";

export interface PessoaConhecida {
    id: string;
    /** Nome completo, nome de exibição e qualquer outra grafia cadastrada. */
    nomes: Array<string | null | undefined>;
}

export interface AlvoConhecido {
    dominio: DominioDoAlvo;
    codigo: string;
    rotulo: string;
}

export interface Legenda {
    mesAncora: string;
    pessoas: Array<{ pseudonimo: string; nome: string }>;
    contas: Array<{ pseudonimo: string; email: string }>;
    alvos: Array<{ pseudonimo: string; codigo: string; rotulo: string }>;
    ids: Array<{ pseudonimo: string; id: string }>;
}

const SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;
const PARTICULAS = new Set(["de", "da", "do", "dos", "das", "e", "di", "del"]);
/* Sobrenomes que também são palavra comum: só mascara quando vêm com inicial
   maiúscula, senão "2 dias" e "a costa" virariam [nome]. */
const SOBRENOME_PALAVRA_COMUM = new Set([
    "dias", "campos", "reis", "paz", "luz", "neves", "franco", "leal", "rocha", "costa", "lima",
    "pinto", "leite", "ramos", "cruz", "santos", "prado", "vale", "serra", "flores", "pena",
    "barros", "matos", "rosa", "guerra", "rios", "monte", "sales", "bom", "brito", "cunha",
]);
// Ramais eventuais da madrugada (docs/madrugada.md): a regra de pagamento depende deles.
const RAMAIS_EVENTUAIS_MADRUGADA = new Set(["2266", "2267", "2268", "2269", "2270"]);

const MARCAS = "[\\u0300-\\u036f]*";
const ABRE = "";
const FECHA = "";
const PSEUDONIMO = "(?:\\[nome\\]|(?:MED|PESSOA)-[0-9a-f]{8})";

function semAcento(valor: string) {
    return valor.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function chaveDoNome(valor: string) {
    return semAcento(valor).toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
}

function escapar(valor: string) {
    return valor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Casa o termo sem depender de acento nem de caixa, num texto já em NFD. */
function padraoSemAcento(termo: string) {
    return [...semAcento(termo)].map((letra) => (/\s/.test(letra) ? "\\s+" : `${escapar(letra)}${MARCAS}`)).join("");
}

function diasEntre(deIso: string, ateIso: string) {
    return Math.round((Date.parse(`${ateIso}T00:00:00Z`) - Date.parse(`${deIso}T00:00:00Z`)) / 86_400_000);
}

export class Mascara {
    private readonly segredo: string;
    private readonly mesAncora: string;
    private readonly diaZero: string;
    private readonly pessoaPorChave = new Map<string, string>();
    private readonly nomeDaPessoa = new Map<string, string>();
    private readonly donosDoTermo = new Map<string, Set<string>>();
    private readonly alvos: AlvoConhecido[];
    private readonly usadas = {
        pessoas: new Map<string, string>(),
        contas: new Map<string, string>(),
        alvos: new Map<string, { codigo: string; rotulo: string }>(),
        ids: new Map<string, string>(),
    };
    private regexDeNomes: RegExp | null = null;

    constructor(opcoes: { segredo: string; mesAncora: string; pessoas: PessoaConhecida[]; alvos: AlvoConhecido[] }) {
        if (!/^\d{4}-\d{2}$/.test(opcoes.mesAncora)) {
            throw new Error("Mês do caso inválido.");
        }
        this.segredo = opcoes.segredo;
        this.mesAncora = opcoes.mesAncora;
        this.diaZero = `${opcoes.mesAncora}-01`;
        this.alvos = opcoes.alvos;
        for (const pessoa of opcoes.pessoas) {
            const pseudonimo = `MED-${this.hash("medico", pessoa.id)}`;
            for (const nome of pessoa.nomes) {
                if (nome?.trim()) this.cadastrarNome(nome, pseudonimo);
            }
        }
    }

    private hash(tipo: string, valor: string) {
        return createHmac("sha256", this.segredo).update(`extrator-caso:v1:${tipo}:${valor}`).digest("hex").slice(0, 8);
    }

    private cadastrarNome(nome: string, pseudonimo: string) {
        const chave = chaveDoNome(nome);
        if (!chave) return;
        if (!this.pessoaPorChave.has(chave)) this.pessoaPorChave.set(chave, pseudonimo);
        if (!this.nomeDaPessoa.has(pseudonimo)) this.nomeDaPessoa.set(pseudonimo, nome.trim());
        for (const termo of chave.split(" ")) {
            if (termo.length < 3 || PARTICULAS.has(termo)) continue;
            const donos = this.donosDoTermo.get(termo) ?? new Set<string>();
            donos.add(pseudonimo);
            this.donosDoTermo.set(termo, donos);
        }
        this.regexDeNomes = null;
    }

    private usarPessoa(pseudonimo: string) {
        this.usadas.pessoas.set(pseudonimo, this.nomeDaPessoa.get(pseudonimo) ?? "");
        return pseudonimo;
    }

    pessoaPorId(id: string) {
        return this.usarPessoa(`MED-${this.hash("medico", id)}`);
    }

    /** Nome solto (chefia, sucessor): cai no médico cadastrado, senão ganha pseudônimo próprio. */
    pessoaPorNome(nome: string | null | undefined) {
        const chave = chaveDoNome(nome ?? "");
        if (!chave) return null;
        let pseudonimo = this.pessoaPorChave.get(chave);
        if (!pseudonimo) {
            pseudonimo = `PESSOA-${this.hash("nome", chave)}`;
            this.cadastrarNome(nome as string, pseudonimo);
        }
        return this.usarPessoa(pseudonimo);
    }

    conta(email: string | null | undefined) {
        const limpo = email?.trim().toLowerCase();
        if (!limpo) return null;
        const pseudonimo = `CONTA-${this.hash("email", limpo)}`;
        this.usadas.contas.set(pseudonimo, limpo);
        return pseudonimo;
    }

    alvo(dominio: DominioDoAlvo, codigo: string | null | undefined, rotulo?: string | null) {
        const limpo = codigo?.trim();
        if (!limpo) return null;
        const prefixo = dominio === "regulation" ? "REG" : "USA";
        let pseudonimo = `${prefixo}-${this.hash(`alvo:${dominio}`, limpo)}`;
        // A regra de negócio depende destes dois papéis; o ramal em si continua oculto.
        if (dominio === "regulation" && limpo === CHIEF_REGULATION_POST_CODE) pseudonimo = "REG-CHEFIA";
        else if (dominio === "regulation" && RAMAIS_EVENTUAIS_MADRUGADA.has(limpo)) pseudonimo = `REG-EVENTUAL-${this.hash("alvo:regulation", limpo).slice(0, 4)}`;
        const conhecido = this.alvos.find((item) => item.dominio === dominio && item.codigo === limpo);
        this.usadas.alvos.set(pseudonimo, { codigo: limpo, rotulo: rotulo?.trim() || conhecido?.rotulo || "" });
        return pseudonimo;
    }

    id(valor: string | null | undefined) {
        const limpo = valor?.trim().toLowerCase();
        if (!limpo) return null;
        const existente = [...this.usadas.ids].find(([, id]) => id === limpo);
        if (existente) return existente[0];
        const pseudonimo = `ID-${this.usadas.ids.size + 1}`;
        this.usadas.ids.set(pseudonimo, limpo);
        return pseudonimo;
    }

    /** Dia civil (AAAA-MM-DD) → "D+03 qua", contado do dia 1 do mês do caso. */
    dia(iso: string | null | undefined) {
        const limpo = iso?.slice(0, 10);
        if (!limpo || !/^\d{4}-\d{2}-\d{2}$/.test(limpo) || Number.isNaN(Date.parse(`${limpo}T00:00:00Z`))) return null;
        const distancia = diasEntre(this.diaZero, limpo);
        const sinal = distancia < 0 ? "-" : "+";
        const semana = SEMANA[new Date(`${limpo}T00:00:00Z`).getUTCDay()];
        return `D${sinal}${String(Math.abs(distancia)).padStart(2, "0")} ${semana}`;
    }

    /** Instante → "D+03 qua 19:04", no relógio operacional (UTC-3). */
    instante(iso: string | null | undefined) {
        if (!iso || Number.isNaN(Date.parse(iso))) return null;
        return `${this.dia(bahiaDateIso(iso))} ${bahiaClockHHMM(iso)}`;
    }

    /** "AAAA-MM" → "M0", "M-1", "M+2". */
    mes(chave: string | null | undefined) {
        const partes = chave?.match(/^(\d{4})-(\d{2})/);
        const ancora = this.mesAncora.match(/^(\d{4})-(\d{2})$/);
        if (!partes || !ancora) return null;
        const distancia = (Number(partes[1]) - Number(ancora[1])) * 12 + (Number(partes[2]) - Number(ancora[2]));
        return distancia === 0 ? "M0" : `M${distancia > 0 ? "+" : ""}${distancia}`;
    }

    private regexNomes() {
        if (!this.regexDeNomes) {
            const termos = [...this.donosDoTermo.keys()].sort((a, b) => b.length - a.length).map(padraoSemAcento);
            this.regexDeNomes = termos.length
                ? new RegExp(`(?<![\\p{L}\\p{N}\\u0300-\\u036f])(?:${termos.join("|")})(?![\\p{L}\\p{N}])`, "giu")
                : /(?!)/g;
        }
        return this.regexDeNomes;
    }

    /** dd/mm sem ano: assume o ano que deixa a data mais perto do mês do caso. */
    private diaSemAno(dia: string, mes: string) {
        const ano = Number(this.mesAncora.slice(0, 4));
        const candidatos = [ano - 1, ano, ano + 1]
            .map((a) => `${a}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`)
            .filter((iso) => {
                const instante = Date.parse(`${iso}T00:00:00Z`);
                return !Number.isNaN(instante) && new Date(instante).toISOString().slice(0, 10) === iso;
            });
        candidatos.sort((a, b) => Math.abs(diasEntre(this.diaZero, a)) - Math.abs(diasEntre(this.diaZero, b)));
        return candidatos[0] ? this.dia(candidatos[0]) : null;
    }

    /** Texto livre: troca o que reconhece e guarda o resto. Não garante nome de quem não é médico cadastrado. */
    texto(valor: string | null | undefined) {
        if (valor === null || valor === undefined) return null;
        const trocas: string[] = [];
        const guardar = (troca: string | null, original: string) => {
            if (troca === null) return original;
            trocas.push(troca);
            return `${ABRE}${trocas.length - 1}${FECHA}`;
        };
        let texto = valor.normalize("NFD");

        texto = texto.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (email) => guardar(this.conta(email), email));
        texto = texto.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => guardar(this.id(id), id));
        texto = texto.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, (iso) => guardar(this.instante(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`), iso));
        texto = texto.replace(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, (iso) => guardar(this.dia(iso), iso));
        texto = texto.replace(/(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/g, (tudo, d: string, m: string, a: string) => guardar(this.dia(`${a}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`), tudo));
        texto = texto.replace(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, (tudo, d: string, m: string) => guardar(Number(m) >= 1 && Number(m) <= 12 ? this.diaSemAno(d, m) : null, tudo));
        texto = texto.replace(/(?<![\d-])\d{4}-(?:0[1-9]|1[0-2])(?![\d-])/g, (chave) => guardar(this.mes(chave), chave));

        for (const alvo of [...this.alvos].sort((a, b) => b.rotulo.length - a.rotulo.length)) {
            for (const termo of [alvo.rotulo, alvo.codigo]) {
                if (termo.trim().length < 3) continue;
                const regex = new RegExp(`(?<![\\p{L}\\p{N}\\u0300-\\u036f])${padraoSemAcento(termo.trim())}(?![\\p{L}\\p{N}])`, "giu");
                texto = texto.replace(regex, (achado) => guardar(this.alvo(alvo.dominio, alvo.codigo, alvo.rotulo), achado));
            }
        }

        // Telefone, CPF, CNPJ, nº de ocorrência, nº de processo. Antes dos nomes,
        // para não confundir os dígitos de um pseudônimo com número solto.
        texto = texto.replace(/(?<![\w])\d(?:[.\-/() ]{0,2}\d){8,}(?![\w])/g, "[número]");
        texto = texto.replace(/(?<![\w])\d{6,}(?![\w])/g, "[número]");

        texto = texto.replace(this.regexNomes(), (achado) => {
            const termo = chaveDoNome(achado);
            if (SOBRENOME_PALAVRA_COMUM.has(termo) && achado[0] === achado[0].toLowerCase()) return achado;
            const donos = this.donosDoTermo.get(termo);
            if (!donos) return achado;
            return donos.size === 1 ? this.usarPessoa([...donos][0]) : "[nome]";
        });
        // "Maria de Souza" vira uma pessoa só: fica o pseudônimo mais específico da
        // sequência. Sobrenome-palavra-comum colado num nome ("joaquina dias") vai junto.
        const comuns = [...SOBRENOME_PALAVRA_COMUM].filter((termo) => this.donosDoTermo.has(termo)).map(padraoSemAcento);
        const pedaco = comuns.length ? `(?:${PSEUDONIMO}|(?:${comuns.join("|")})(?![\\p{L}\\p{N}]))` : PSEUDONIMO;
        texto = texto.replace(
            new RegExp(`${PSEUDONIMO}(?:\\s+(?:(?:de|da|do|dos|das|e)\\s+)?${pedaco})+`, "giu"),
            (sequencia) => sequencia.match(/(?:MED|PESSOA)-[0-9a-f]{8}/)?.[0] ?? "[nome]",
        );

        return texto
            .replace(new RegExp(`${ABRE}(\\d+)${FECHA}`, "g"), (_, indice: string) => trocas[Number(indice)])
            .normalize("NFC");
    }

    /** JSON solto (detalhes de auditoria): mantém as chaves, mascara todo valor de texto. */
    json(valor: unknown): unknown {
        if (typeof valor === "string") return this.texto(valor);
        if (Array.isArray(valor)) return valor.map((item) => this.json(item));
        if (valor && typeof valor === "object") {
            return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, this.json(item)]));
        }
        return valor;
    }

    legenda(): Legenda {
        return {
            mesAncora: this.mesAncora,
            pessoas: [...this.usadas.pessoas].map(([pseudonimo, nome]) => ({ pseudonimo, nome })),
            contas: [...this.usadas.contas].map(([pseudonimo, email]) => ({ pseudonimo, email })),
            alvos: [...this.usadas.alvos].map(([pseudonimo, alvo]) => ({ pseudonimo, ...alvo })),
            ids: [...this.usadas.ids].map(([pseudonimo, id]) => ({ pseudonimo, id })),
        };
    }
}
