import type { BankHoursApproval } from "@/modules/reporting/bank-hours-approval";

/**
 * Estado da validação da chefia, com cor + ícone + texto — nunca só cor.
 * É a informação que mais gerava questionamento: o médico avisou que saiu
 * depois e nunca soube se alguém validou.
 */
export function ApprovalBadge({ approval }: { approval: BankHoursApproval }) {
    if (approval.state === "sem_pendencia") return null;

    const icone = {
        ok: "✓",
        pending: "⏳",
        warn: "▲",
        neutral: "•",
    }[approval.tone];

    return (
        <section className={`panel-approval tone-${approval.tone}`}>
            <p className="panel-approval-head">
                <span aria-hidden="true">{icone}</span>
                <strong>{approval.label}</strong>
            </p>
            <p className="panel-approval-detail">{approval.detail}</p>
            {approval.chiefName && approval.state === "validado" ? (
                <p className="panel-approval-meta">Validado por {approval.chiefName}</p>
            ) : null}
            {approval.note ? <p className="panel-approval-note">“{approval.note}”</p> : null}
        </section>
    );
}
