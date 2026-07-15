type ReplyKind = "arrival_recorded" | "arrival_p_recorded" | "half_shift_assumed" | "continuation_recorded" | "reassignment_recorded" | "departure_recorded" | "departure_adjusted" | "half_shift_already_closed" | "departure_justification_required" | "departure_justification_retry" | "departure_justification_recorded" | "departure_justification_manual_review" | "departure_occurrence_number_required" | "departure_occurrence_number_retry" | "departure_not_found" | "departure_time_conflict" | "departure_missing_context" | "no_operational_match" | "candidate_prompt" | "name_unresolved" | "command_forbidden" | "command_usage" | "command_corrected" | "command_removed" | "command_deleted" | "casual_smalltalk";

interface NamedCandidate {
    fullName: string;
    displayName?: string | null;
}

interface TelegramBatchReviewEntry {
    lineNumber: number;
    doctorName: string;
    targetCode: string;
    timeLabel: string;
    sector: "REGULATION" | "INTERVENTION";
    mode: "arrival" | "continuation";
}

interface TelegramBatchReviewIssue {
    lineNumber: number;
    rawLine: string;
    reason: string;
}

const REPLIES: Record<ReplyKind, string[]> = {
    arrival_recorded: [
        "Chegada registrada.\n{name} assumiu {target} às {time}.\nQuadro atualizado.",
    ],
    arrival_p_recorded: [
        "Chegada em P registrada.\n{name} assumiu {target} às {time}.\nEssa cobertura vale para este plantão e o próximo.",
    ],
    half_shift_assumed: [
        "Supus que você está no meio plantão da tarde em {target}.\n{name} está no quadro desde {time} e vou encerrar automaticamente às 17:00.\nNo pagamento, isso entra como MEIO.",
    ],
    continuation_recorded: [
        "Continuidade registrada.\n{name} segue em {target} desde {time}.\nMantive a chegada original e só estendi a cobertura.",
    ],
    reassignment_recorded: [
        "Remanejamento registrado.\n{name} agora está em {target} desde {time}.\nOcupação anterior encerrada automaticamente.",
    ],
    departure_recorded: [
        "Saída registrada: {name} deixou {target} às {time}.",
    ],
    departure_adjusted: [
        "Ajustei a saída real de {name} em {target} para {time}.\nO painel segue com quem assumiu; pagamento e banco de horas ficaram com o horário real.",
    ],
    half_shift_already_closed: [
        "Eu já tinha tirado {name} do painel às 17:00 em {target}.\nEsse meio plantão fecha automático no horário e já foi registrado como MEIO para pagamento.\nPor enquanto não tem banco de horas para essa função: a saída prevista era 17:00, distribuindo as ocorrências.",
    ],
    departure_justification_required: [
        "Entendi a saída tardia de {name} em {target}, mas aqui já havia rendição e só considero minutos extras para pagamento e banco de horas com motivo válido por escrito.\n\n🚑 Em ocorrência\nEx.: estava em ocorrência 0729\n\n🧼 Higienizando\nEx.: estava higienizando a viatura\n\nSe o horário {time} está certo, responda só com um desses motivos. Se o horário mudou, reenvie a saída completa assim: {example}",
    ],
    departure_justification_retry: [
        "Ainda não consegui reconhecer um motivo válido para crédito automático dessa saída tardia de {name} em {target}.\n\n🚑 Em ocorrência\nEx.: estava em ocorrência 0729\n\n🧼 Higienizando\nEx.: estava higienizando a viatura\n\nPode tentar explicar mais uma vez só com o motivo. Se eu ainda não conseguir confirmar ocorrência ou higienização, deixo a justificativa salva para coordenação, mas sem crédito automático e só a chefia poderá lançar esses minutos extras.",
    ],
    departure_occurrence_number_required: [
        "Entendi que {name} saiu tarde de {target} por ocorrência. Para creditar esses minutos no banco de horas eu preciso saber QUAL ocorrência — me responda só com o número dela (4 dígitos).\n\nEx.: ocorrência 4521\n\nSe o horário {time} mudou, reenvie a saída completa assim: {example}",
    ],
    departure_occurrence_number_retry: [
        "Ainda não recebi o número da ocorrência (4 dígitos) de {name} em {target}. Responda só com o número.\n\nEx.: 4521\n\nSe eu continuar sem o número, deixo a saída registrada para a chefia revisar, mas sem crédito automático no banco de horas.",
    ],
    departure_justification_recorded: [
        "Justificativa recebida. Anexei o motivo à saída de {name} em {target} às {time}. Isso já ficou registrado para a coordenação, pagamento e banco de horas.",
    ],
    departure_justification_manual_review: [
        "Guardei a justificativa da saída de {name} em {target} às {time} para coordenação, mas não consegui validar ocorrência ou higienização com segurança. Por isso, os minutos extras ficaram sem crédito automático. Se esse extra precisar entrar, só a chefia de plantão poderá lançar.",
    ],
    departure_not_found: [
        "Entendi a saída de {name} em {target}, mas não achei ocupação compatível para fechar por aqui. Se a saída real foi diferente da rendição, reenvie assim: {example}",
    ],
    departure_time_conflict: [
        "Entendi a saída de {name} em {target}, mas esse horário ficou antes da chegada registrada. Reenvie com o horário certo. Ex.: {example}",
    ],
    departure_missing_context: [
        "Entendi que você quis registrar uma saída, mas faltou base ou horário. Reenvie assim: {example}",
    ],
    no_operational_match: [
        "Não entendi como registro de plantão.\nChegada: `{arrivalExample}`\nSaída: `{departureExample}`\nDúvida? Mande /ajuda",
    ],
    candidate_prompt: [
        "Falta só confirmar o nome do médico.",
    ],
    name_unresolved: [
        "Não consegui confirmar o nome do médico com segurança.",
    ],
    command_forbidden: [
        "Esse comando fica restrito à chefia e administração. Se precisar, chame um chefe para ajustar por aqui.",
    ],
    command_usage: [
        "Não entendi o comando inteiro. Use o formato {usage}.",
    ],
    command_corrected: [
        "Correção aplicada em {target}: chegada de {name} registrada às {time}.",
    ],
    command_removed: [
        "Retirei {name} de {target} com saída às {time}.",
    ],
    command_deleted: [
        "Apaguei o registro de {name} em {target} da memória operacional.",
    ],
    casual_smalltalk: [
        "Bom plantão por aí.",
    ],
};

// Vocabulário visual único (auditoria §2): 1 emoji por significado, sempre no
// início da 1ª linha. ✅ sucesso · ⛔ bloqueio · ⚠️ ação do usuário · 👋 saída ·
// 🔁 continuidade/remanejo · 🛠️ correção administrativa · ⏰ prazo/automático ·
// 🔎 revisão da chefia · ☀️/🌙 turno dia/noite.
const REPLY_PREFIX: Record<ReplyKind, string> = {
    arrival_recorded: "✅",
    arrival_p_recorded: "🔁",
    half_shift_assumed: "☀️",
    continuation_recorded: "🔁",
    reassignment_recorded: "🔁",
    departure_recorded: "👋",
    departure_adjusted: "🛠️",
    half_shift_already_closed: "⏰",
    departure_justification_required: "⚠️",
    departure_justification_retry: "⚠️",
    departure_occurrence_number_required: "⚠️",
    departure_occurrence_number_retry: "⚠️",
    departure_justification_recorded: "✅",
    departure_justification_manual_review: "🔎",
    departure_not_found: "⛔",
    departure_time_conflict: "⛔",
    departure_missing_context: "⛔",
    no_operational_match: "⛔",
    candidate_prompt: "⚠️",
    name_unresolved: "⚠️",
    command_forbidden: "⛔",
    command_usage: "⛔",
    command_corrected: "🛠️",
    command_removed: "👋",
    command_deleted: "✅",
    casual_smalltalk: "💬",
};

const GROUP_CORRECTION_ANNOUNCEMENTS = [
    "🛠️\nAjuste administrativo concluído.\n{name} ficou em {target} desde {time}.",
];

const CHIEF_KICK_ANNOUNCEMENTS = [
    "👋\nSaída declarada pelo chefe de plantão.\n{name} saiu de {target} às {time}.",
];

export function buildChiefKickAnnouncement(seed: string | number, params: { name: string; target: string; time: string }) {
    const numericSeed = String(seed)
        .split("")
        .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const template = CHIEF_KICK_ANNOUNCEMENTS[numericSeed % CHIEF_KICK_ANNOUNCEMENTS.length];
    return interpolate(template, params);
}

function interpolate(template: string, params: Record<string, string>) {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? "");
}

function formatCandidateList(candidates: NamedCandidate[]) {
    return candidates
        .slice(0, 3)
        .map((candidate, index) => `${index + 1}. ${candidate.displayName?.trim() || candidate.fullName}`)
        .join("\n");
}

export function pickTelegramReply(kind: ReplyKind, seed: string | number, params: Record<string, string>) {
    const variants = REPLIES[kind];
    const numericSeed = String(seed)
        .split("")
        .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const template = variants[numericSeed % variants.length];
    return `${REPLY_PREFIX[kind]} ${interpolate(template, params)}`;
}

export function buildCandidatePromptReply(seed: string | number, candidates: NamedCandidate[], context?: { target?: string; time?: string | null; shift?: string | null }) {
    const intro = pickTelegramReply("candidate_prompt", seed, {});
    const list = formatCandidateList(candidates);
    const contextParts: string[] = [];
    if (context?.target) contextParts.push(`local ${context.target}`);
    if (context?.time) contextParts.push(`horário ${context.time}`);
    if (context?.shift) contextParts.push(`turno ${context.shift}`);
    const contextLine = contextParts.length > 0 ? `\n\nDetectei: ${contextParts.join(" · ")}` : "";
    // TTL real da pendência: 30 min (PENDING_TTL_MS em service.ts).
    // O balão sai com botões inline (um por candidato); o texto preserva os
    // fallbacks 1/2/3 e redigitação (auditoria §3.1#5).
    return `${intro}${contextLine}\n\nMais próximos:\n${list}\n\nToque no nome abaixo — ou:\nResponda com 1, 2 ou 3, ou redigite nome e sobrenome.\nEssa confirmação expira em 30 min.`;
}

export function buildNameUnresolvedReply(seed: string | number, candidates: NamedCandidate[] = []) {
    const intro = pickTelegramReply("name_unresolved", seed, {});
    const suggestionBlock = candidates.length > 0
        ? `\n\nMais próximos:\n${formatCandidateList(candidates)}`
        : "";
    return `${intro}${suggestionBlock}\n\nPor favor, redigite o nome com nome e sobrenome.\nSe puder, mande junto a base ou o ramal.`;
}

export function buildGroupCorrectionAnnouncement(seed: string | number, params: Record<string, string>) {
    const numericSeed = String(seed)
        .split("")
        .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const template = GROUP_CORRECTION_ANNOUNCEMENTS[numericSeed % GROUP_CORRECTION_ANNOUNCEMENTS.length];
    return interpolate(template, params);
}

export function buildTelegramBatchReviewReply(params: {
    entries: TelegramBatchReviewEntry[];
    issues: TelegramBatchReviewIssue[];
}) {
    const header = params.issues.length === 0
        ? `✅ Conferi o lote. ${params.entries.length} lançamentos ficaram prontos para gravar.`
        : `⚠️ Conferi o lote. ${params.entries.length} lançamentos ficaram prontos e ${params.issues.length} precisam de correção antes de autorizar.`;

    const entryLines = params.entries.length === 0
        ? ""
        : `\n\nProntos para lançar:\n${params.entries.map((entry) => {
            const modeLabel = entry.mode === "continuation" ? "continua" : entry.timeLabel;
            const sectorLabel = entry.sector === "REGULATION" ? "REG" : "INT";
            return `${entry.lineNumber}. [${sectorLabel}] ${entry.targetCode} - ${entry.doctorName} - ${modeLabel}`;
        }).join("\n")}`;

    const issueLines = params.issues.length === 0
        ? ""
        : `\n\nCorrigir antes de autorizar:\n${params.issues.map((issue) => `${issue.lineNumber}. ${issue.reason} -> ${issue.rawLine}`).join("\n")}`;

    const footer = params.issues.length === 0
        ? "\n\nResponda CONFIRMAR para lançar tudo de uma vez ou CANCELAR para descartar este lote."
        : "\n\nReenvie o bloco corrigido. Quando tudo fechar, eu mostro a prévia final e espero seu CONFIRMAR.";

    return `${header}${entryLines}${issueLines}${footer}`;
}

export function buildTelegramBatchApplyReply(params: {
    appliedCount: number;
    failed: Array<{ lineNumber: number; reason: string }>;
}) {
    if (params.failed.length === 0) {
        return `✅ Lote autorizado e lançado. ${params.appliedCount} registros foram gravados.`;
    }

    return `⚠️ Lancei ${params.appliedCount} registros do lote, mas ${params.failed.length} falharam na hora de gravar:\n${params.failed.map((item) => `${item.lineNumber}. ${item.reason}`).join("\n")}`;
}