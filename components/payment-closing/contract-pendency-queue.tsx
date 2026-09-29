/**
 * Fila de pendências de contrato, agrupada por tipo. Só leitura: cada linha
 * leva à tela que já corrige (modal do médico no fechamento, ou o cadastro de
 * médicos). A classificação é de services/contract-pendency-queue.service.ts.
 */
import {
    CONTRACT_PENDENCY_KINDS,
    contractPendencyHref,
    type ContractPendencyKind,
    type ContractPendencyQueue,
} from "@/services/contract-pendency-queue.service";

const GROUPS: Record<ContractPendencyKind, { title: string; action: string; tone: "danger" | "warn" | "neutral" }> = {
    sem_contrato: { title: "Plantonando sem contrato", action: "Cadastrar contrato", tone: "danger" },
    vencido: { title: "Contrato vencido sem renovação", action: "Renovar contrato", tone: "danger" },
    sem_saldo_de_abertura: { title: "Sem saldo de abertura", action: "Lançar saldo", tone: "warn" },
    sem_teto: { title: "Contrato sem teto", action: "Lançar teto", tone: "warn" },
    vinculo_suspeito: { title: "Vínculo possivelmente errado", action: "Conferir vínculo", tone: "warn" },
    sem_plantao_recente: { title: "Ativo sem plantão recente", action: "Conferir cadastro", tone: "neutral" },
};

export function ContractPendencyQueueView({ queue }: { queue: ContractPendencyQueue }) {
    if (queue.total === 0) {
        return (
            <section className="payment-empty-state standalone">
                <strong>Nenhuma pendência de contrato</strong>
                <span>Todo médico ativo acompanhado tem contrato vigente, teto e saldo de abertura.</span>
            </section>
        );
    }

    return (
        <div className="contract-queue">
            <p className="contract-queue-summary">
                <strong>{queue.total}</strong> pendência{queue.total === 1 ? "" : "s"} · posição de{" "}
                {queue.asOf.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}
            </p>
            {CONTRACT_PENDENCY_KINDS.filter((kind) => queue.counts[kind] > 0).map((kind) => {
                const group = GROUPS[kind];
                return (
                    <section key={kind} className={`contract-queue-group ${group.tone}`}>
                        <h2>
                            {group.title} <span className={`reports-badge ${group.tone}`}>{queue.counts[kind]}</span>
                        </h2>
                        <ul>
                            {queue.items.filter((item) => item.kind === kind).map((item) => {
                                const href = contractPendencyHref(item);
                                return (
                                <li key={`${kind}-${item.doctorId}`}>
                                    <div>
                                        <strong>{item.doctorName}</strong>
                                        {item.contractNumber ? <small> · contrato {item.contractNumber}</small> : null}
                                        <p>{item.detail}</p>
                                    </div>
                                    {href ? (
                                        <a className="payment-button subtle" href={href}>
                                            {group.action}
                                        </a>
                                    ) : null}
                                </li>
                                );
                            })}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}
