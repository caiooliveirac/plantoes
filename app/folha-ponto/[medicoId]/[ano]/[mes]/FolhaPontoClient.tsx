"use client";

import { useEffect, useMemo, useState } from "react";
import { montarLinhasFrequencia, montarRelatorio } from "@/lib/folha-ponto/montar";
import type { DadosFolhaPonto } from "@/lib/folha-ponto/types";
import prefeituraLogo from "@/components/prefeitura-de-salvador.jpg";
import samuLogo from "@/components/samu192.png";
import "./folha-ponto.css";

const MESES_PT = [
    "JANEIRO",
    "FEVEREIRO",
    "MARÇO",
    "ABRIL",
    "MAIO",
    "JUNHO",
    "JULHO",
    "AGOSTO",
    "SETEMBRO",
    "OUTUBRO",
    "NOVEMBRO",
    "DEZEMBRO",
];

const ENDERECO_SAMU =
    "Rua Marques de Maricá – Complexo Cesar de Araujo - Largo do Tamarineiro – Pau Miudo - Salvador - BA - CEP: 40.320-350 Tel. 3202-1320";

interface CamposEditaveis {
    empresa: string;
    cnpj: string;
    razaoSocial: string;
    localData: string;
}

function storageKey(medicoId: string) {
    return `folhaPonto:${medicoId}`;
}

function preferStoredValue(stored: unknown, fallback: string) {
    if (typeof stored !== "string") {
        return fallback;
    }

    const normalized = stored.trim();
    return normalized.length > 0 ? normalized : fallback;
}

function loadCampos(medicoId: string, fallback: CamposEditaveis): CamposEditaveis {
    if (typeof window === "undefined") return fallback;
    try {
        const raw = window.localStorage.getItem(storageKey(medicoId));
        const parsed = raw ? (JSON.parse(raw) as Partial<CamposEditaveis>) : {};
        return {
            // Empresa/CNPJ/razão social são confirmados pelo médico no bot do
            // Telegram — uma vez que o banco já tem o dado, ele manda sempre.
            // O cache local só serve de rascunho enquanto ainda não há
            // confirmação (fallback vazio); senão um valor salvo neste
            // navegador antes da confirmação (inclusive vazio/placeholder de
            // teste) ficaria escondendo o dado real para sempre.
            empresa: fallback.empresa || preferStoredValue(parsed.empresa, fallback.empresa),
            cnpj: fallback.cnpj || preferStoredValue(parsed.cnpj, fallback.cnpj),
            razaoSocial: fallback.razaoSocial || preferStoredValue(parsed.razaoSocial, fallback.razaoSocial),
            // localData NÃO é restaurado do cache: ele depende do mês da folha e
            // do dia da emissão. Um valor salvo em outra emissão (ou em outro
            // mês) reapareceria como data errada no documento impresso.
            localData: fallback.localData,
        };
    } catch {
        return fallback;
    }
}

interface EditavelProps {
    valor: string;
    placeholder: string;
    onChange: (next: string) => void;
    className?: string;
}

function Editavel({ valor, placeholder, onChange, className }: EditavelProps) {
    return (
        <span
            className={`editavel${className ? ` ${className}` : ""}${valor ? "" : " editavel-vazio"}`}
            contentEditable
            suppressContentEditableWarning
            onBlur={(event) => onChange(event.currentTarget.textContent?.trim() ?? "")}
            data-placeholder={placeholder}
        >
            {valor}
        </span>
    );
}

export function FolhaPontoClient({ data }: { data: DadosFolhaPonto }) {
    const fallback = useMemo<CamposEditaveis>(
        () => ({
            empresa: data.medico.razaoSocial ?? "",
            cnpj: data.medico.cnpj ?? "",
            razaoSocial: data.medico.razaoSocial ?? "",
            localData: data.localData,
        }),
        [data.localData, data.medico.cnpj, data.medico.razaoSocial],
    );

    const [campos, setCampos] = useState<CamposEditaveis>(fallback);
    const [hidratado, setHidratado] = useState(false);

    useEffect(() => {
        setCampos(loadCampos(data.medico.id, fallback));
        setHidratado(true);
    }, [data.medico.id, fallback]);

    useEffect(() => {
        if (!hidratado) return;
        try {
            window.localStorage.setItem(storageKey(data.medico.id), JSON.stringify(campos));
        } catch {
            // localStorage cheio ou indisponível: ignorar silenciosamente
        }
    }, [campos, data.medico.id, hidratado]);

    const linhasFreq = useMemo(() => montarLinhasFrequencia(data.plantoes), [data.plantoes]);
    const linhasRelatorio = useMemo(() => montarRelatorio(data.plantoes, data.mes), [data.plantoes, data.mes]);

    const mesLabel = MESES_PT[data.mes - 1] ?? "";

    function setCampo<K extends keyof CamposEditaveis>(key: K, valor: string) {
        setCampos((prev) => (prev[key] === valor ? prev : { ...prev, [key]: valor }));
    }

    const linhasRelatorioFixas = Array.from({ length: 25 }, (_, i) => linhasRelatorio[i] ?? null);

    return (
        <div className="folha-ponto-root">
            <div className="folha-ponto-toolbar no-print">
                <button type="button" className="folha-ponto-print-btn" onClick={() => window.print()}>
                    Imprimir
                </button>
                <small>Clique em qualquer campo cinza-claro para editar. Os valores ficam salvos neste navegador.</small>
            </div>

            <section className="folha-ponto-page page-break">
                <header className="fp-cabecalho">
                    <div className="fp-cabecalho-esq">
                        <div className="fp-cabecalho-secretaria">Secretaria da Saúde</div>
                        <img
                            src={prefeituraLogo.src}
                            alt="Logo da Prefeitura de Salvador"
                            className="fp-cabecalho-logo-salvador"
                        />
                    </div>
                    <h1 className="fp-titulo">
                        Frequência – <strong>{mesLabel}/{data.ano}</strong>
                    </h1>
                    <img src={samuLogo.src} alt="Logo SAMU 192" className="fp-cabecalho-logo-samu" />
                </header>

                <section className="fp-meta-pg1">
                    <div className="fp-meta-grid">
                        <div className="fp-meta-col">
                            <div className="fp-meta-row">
                                <span className="fp-meta-label">NOME:</span>
                                <span className="fp-meta-valor">{data.medico.nome}</span>
                            </div>
                            <div className="fp-meta-row">
                                <span className="fp-meta-label">EMPRESA:</span>
                                <Editavel
                                    valor={campos.empresa}
                                    placeholder="Clique para preencher empresa"
                                    onChange={(v) => setCampo("empresa", v)}
                                />
                            </div>
                            <div className="fp-meta-row">
                                <span className="fp-meta-label">CNPJ:</span>
                                <Editavel
                                    valor={campos.cnpj}
                                    placeholder="Clique para preencher CNPJ"
                                    onChange={(v) => setCampo("cnpj", v)}
                                />
                            </div>
                        </div>
                        <div className="fp-meta-col">
                            <div className="fp-meta-row">
                                <span className="fp-meta-label">Função:</span>
                                <span className="fp-meta-valor">MEDICO</span>
                            </div>
                            <div className="fp-meta-row">
                                <span className="fp-meta-label">Unidade:</span>
                                <span className="fp-meta-valor">SMS/SAMU</span>
                            </div>
                        </div>
                    </div>
                </section>

                <table className="fp-tabela fp-tabela-freq">
                    <colgroup>
                        <col style={{ width: "8%" }} />
                        <col style={{ width: "12%" }} />
                        <col style={{ width: "12%" }} />
                        <col style={{ width: "2.5mm" }} className="fp-tabela-freq-spacer-col" />
                        <col style={{ width: "12%" }} />
                        <col style={{ width: "12%" }} />
                        <col style={{ width: "2.5mm" }} className="fp-tabela-freq-spacer-col" />
                        <col style={{ width: "38%" }} />
                    </colgroup>
                    <thead>
                        <tr>
                            <th>Dia</th>
                            <th>Entrada</th>
                            <th>Saída</th>
                            <th className="fp-tabela-freq-spacer" aria-hidden="true" />
                            <th>Entrada</th>
                            <th>Saída</th>
                            <th className="fp-tabela-freq-spacer" aria-hidden="true" />
                            <th>Assinatura</th>
                        </tr>
                    </thead>
                    <tbody>
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((dia) => {
                            const linha = linhasFreq[dia];
                            return (
                                <tr key={dia}>
                                    <td className="fp-dia">{String(dia).padStart(2, "0")}</td>
                                    <td className="fp-hora">{linha.e1}</td>
                                    <td className="fp-hora">{linha.s1}</td>
                                    <td className="fp-tabela-freq-spacer" aria-hidden="true" />
                                    <td className="fp-hora">{linha.e2}</td>
                                    <td className="fp-hora">{linha.s2}</td>
                                    <td className="fp-tabela-freq-spacer" aria-hidden="true" />
                                    <td className="fp-assinatura" />
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                <section className="fp-localdata-caixa">
                    <span className="fp-localdata-label">Local e Data:</span>
                    <Editavel
                        valor={campos.localData}
                        placeholder="Salvador, dia de mês de ano"
                        onChange={(v) => setCampo("localData", v)}
                        className="fp-localdata-valor"
                    />
                </section>
                <div className="fp-linha-assinatura-pg1" />
            </section>

            <section className="folha-ponto-page">
                <header className="fp-cabecalho-pg2 fp-cabecalho-pg2-logo">
                    <img
                        src={prefeituraLogo.src}
                        alt="Logo da Prefeitura de Salvador"
                        className="fp-cabecalho-logo-relatorio"
                    />
                </header>

                <div className="fp-titulo-bar">
                    <h2>RELATÓRIO DE ATIVIDADES</h2>
                    <span className="fp-versao">v.1</span>
                </div>

                <section className="fp-meta">
                    <div className="fp-meta-row">
                        <span className="fp-meta-label">Empresa:</span>
                        <Editavel
                            valor={campos.empresa}
                            placeholder="Clique para preencher empresa"
                            onChange={(v) => setCampo("empresa", v)}
                        />
                    </div>
                    <div className="fp-meta-row">
                        <span className="fp-meta-label">CNPJ:</span>
                        <Editavel
                            valor={campos.cnpj}
                            placeholder="Clique para preencher CNPJ"
                            onChange={(v) => setCampo("cnpj", v)}
                        />
                    </div>
                    <div className="fp-meta-row">
                        <span className="fp-meta-label">Profissional:</span>
                        <span className="fp-meta-valor">{data.medico.nome}</span>
                    </div>
                </section>

                <table className="fp-tabela fp-tabela-relatorio">
                    <thead>
                        <tr>
                            <th>DATA/MÊS</th>
                            <th>ATIVIDADES</th>
                            <th>ASSINATURA</th>
                        </tr>
                    </thead>
                    <tbody>
                        {linhasRelatorioFixas.map((linha, idx) => (
                            <tr key={idx}>
                                <td className="fp-dia">{linha?.data ?? ""}</td>
                                <td className="fp-atividade">{linha?.atividade ?? ""}</td>
                                <td className="fp-assinatura" />
                            </tr>
                        ))}
                    </tbody>
                </table>

                <section className="fp-localdata-caixa">
                    <span className="fp-localdata-label">Local e Data:</span>
                    <Editavel
                        valor={campos.localData}
                        placeholder="Salvador, dia de mês de ano"
                        onChange={(v) => setCampo("localData", v)}
                        className="fp-localdata-valor"
                    />
                </section>

                <section className="fp-assinaturas-pg2">
                    <div className="fp-assinatura-bloco">
                        <span className="fp-linha-assinatura" />
                        <small>Assinatura do profissional</small>
                    </div>
                    <div className="fp-assinatura-bloco">
                        <span className="fp-linha-assinatura" />
                        <small>Assinatura do responsável</small>
                    </div>
                </section>

                <footer className="fp-endereco">{ENDERECO_SAMU}</footer>
            </section>
        </div>
    );
}
