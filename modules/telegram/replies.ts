type ReplyKind = "arrival_recorded" | "continuation_recorded" | "departure_recorded" | "departure_adjusted" | "departure_justification_required" | "departure_not_found" | "departure_time_conflict" | "departure_missing_context" | "candidate_prompt" | "name_unresolved" | "command_forbidden" | "command_usage" | "command_corrected" | "command_removed" | "command_deleted" | "casual_smalltalk";

interface NamedCandidate {
    fullName: string;
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
        "Presenca registrada para {name} em {target} as {time}.",
        "Anotei {name} em {target} a partir de {time}.",
        "Check-in confirmado: {name} assumiu {target} as {time}.",
        "Tudo certo. {name} ficou marcado em {target} as {time}.",
        "Entrada salva: {name} em {target}, horario {time}.",
        "Registrei agora: {name} em {target} as {time}.",
        "Perfeito, {name} entrou em {target} as {time}.",
        "Fechado. {name} consta em {target} desde {time}.",
        "Ja deixei {name} no quadro de {target} a partir de {time}.",
        "Confirmado por aqui: {name} chegou em {target} as {time}.",
        "Certo. {name} foi lancado em {target} as {time}.",
        "Boa. Registrei {name} em {target} no horario {time}.",
        "Entrada confirmada para {name} em {target} as {time}.",
        "Atualizei o plantao: {name} assumindo {target} as {time}.",
        "Ok, {name} ficou ativo em {target} as {time}.",
        "Anotado sem pendencia: {name} em {target} as {time}.",
        "Lancei {name} em {target}. Hora considerada: {time}.",
        "Registro feito. {name} entrou em {target} as {time}.",
        "Tudo registrado: {name}, {target}, {time}.",
        "Check-in salvo. {name} agora aparece em {target} desde {time}.",
    ],
    continuation_recorded: [
        "Continuidade confirmada para {name} em {target}. Mantive a chegada original e registrei a continuidade as {time}.",
        "Anotei que {name} continua em {target}. A chegada inicial foi preservada e a confirmacao ficou em {time}.",
        "Tudo certo. {name} segue em {target}; nao zerei a chegada e marquei a continuidade as {time}.",
        "Continua confirmado: {name} permanece em {target}. A referencia desta confirmacao ficou em {time}.",
        "Fechado. {name} continua em {target} e a chegada original foi mantida. Confirmacao: {time}.",
    ],
    departure_recorded: [
        "Saida registrada para {name} em {target} as {time}.",
        "Anotei a saida de {name} de {target} as {time}.",
        "Check-out confirmado: {name} deixou {target} as {time}.",
        "Tudo certo. {name} saiu de {target} as {time}.",
        "Saida salva: {name} em {target}, horario {time}.",
        "Registrei agora a saida de {name} de {target} as {time}.",
        "Perfeito, {name} encerrou {target} as {time}.",
        "Fechado. {name} foi removido de {target} as {time}.",
        "Ja deixei anotada a saida de {name} de {target} as {time}.",
        "Confirmado por aqui: {name} saiu de {target} as {time}.",
        "Certo. {name} foi baixado de {target} as {time}.",
        "Boa. Registrei a liberacao de {name} em {target} as {time}.",
        "Saida confirmada para {name} em {target} as {time}.",
        "Atualizei o plantao: {name} deixou {target} as {time}.",
        "Ok, {name} nao fica mais no quadro de {target} desde {time}.",
        "Anotado sem pendencia: saida de {name} de {target} as {time}.",
        "Lancei a saida de {name} em {target}. Hora considerada: {time}.",
        "Registro feito. {name} encerrou em {target} as {time}.",
        "Tudo registrado: saida de {name}, {target}, {time}.",
        "Check-out salvo. {name} foi encerrado em {target} as {time}.",
    ],
    departure_adjusted: [
        "Ajustei a saida real de {name} em {target} para {time}. Mantive o painel com quem assumiu e atualizei pagamento e banco de horas.",
        "Considerei {time} como saida real de {name} em {target}. O painel segue com a rendicao e o horario foi para pagamento e banco de horas.",
        "Saida tardia de {name} alinhada em {target}: hora real {time}. Nao mexi em quem assumiu no painel e atualizei banco de horas.",
        "Feito. {name} ficou com saida real as {time} em {target}, sem tirar a rendicao do painel e com reflexo em pagamento.",
        "Atualizei a saida de {name} em {target} para {time}. Painel preservado, horario real ajustado para pagamento.",
    ],
    departure_justification_required: [
        "Entendi a saida de {name} em {target}, mas preciso do horario real e do motivo por escrito para ajustar. Ex.: {example}",
        "Para registrar essa saida de {name} em {target}, reenvie com horario e motivo na mesma mensagem. Ex.: {example}",
        "Nao vou ignorar sua saida em {target}, mas preciso da justificativa por escrito para fechar certo. Ex.: {example}",
        "Consigo ajustar a saida de {name} em {target}, desde que voce reenvie com horario e motivo. Ex.: {example}",
        "Falta so a justificativa escrita para eu considerar a saida de {name} em {target}. Pode mandar assim: {example}",
    ],
    departure_not_found: [
        "Entendi a saida de {name} em {target}, mas nao achei ocupacao compativel para fechar por aqui. Se a saida real foi diferente da rendicao, reenvie assim: {example}",
        "A saida de {name} em {target} foi entendida, mas nao encontrei plantao aberto ou recente para esse medico nesse local. Tente: {example}",
        "Li sua saida em {target}, so que nao achei o registro operacional correspondente. Se precisar ajustar horario real, mande: {example}",
        "Nao ignorei a mensagem, mas ainda nao achei o plantao certo de {name} em {target}. Reenvie no formato: {example}",
        "Entendi a tentativa de saida em {target}, mas preciso de um reenvio mais completo para localizar o registro. Ex.: {example}",
    ],
    departure_time_conflict: [
        "Entendi a saida de {name} em {target}, mas esse horario ficou antes da chegada registrada. Reenvie com o horario certo. Ex.: {example}",
        "A saida de {name} em {target} veio com horario anterior a chegada salva. Mande de novo no formato: {example}",
        "Nao consegui usar esse horario de saida em {target} porque ele ficou antes da entrada registrada. Pode reenviar assim: {example}",
        "Esse horario de saida de {name} em {target} conflita com a chegada registrada. Reenvie com o horario correto. Ex.: {example}",
        "A cronologia dessa saida em {target} nao fechou. Me mande novamente com o horario certo. Ex.: {example}",
    ],
    departure_missing_context: [
        "Entendi que voce quis registrar uma saida, mas faltou base ou horario. Reenvie assim: {example}",
        "Para eu lancar a saida, preciso do local e do horario na mesma mensagem. Ex.: {example}",
        "A intencao de saida ficou clara, mas ainda faltam dados para registrar. Pode mandar assim: {example}",
        "Consigo registrar essa saida se voce reenviar com nome, base e horario. Ex.: {example}",
        "Faltou contexto para eu fechar a saida agora. Reenvie no formato: {example}",
    ],
    candidate_prompt: [
        "Falta so fechar o nome do medico. Escolha uma opcao abaixo ou redigite o nome completo.",
        "Entendi base, horario e acao. Agora preciso que voce confirme o nome do medico.",
        "Encontrei nomes parecidos. Escolha um numero ou redigite nome e sobrenome.",
        "Para eu lancar certo, preciso confirmar o nome. Pode escolher da lista ou redigitar.",
        "O plantao eu entendi. O nome ainda precisa de confirmacao.",
        "Antes de registrar, preciso bater o nome do medico. Escolha ou redigite.",
        "Tenho algumas opcoes proximas. Me diga qual eh a certa ou mande o nome completo.",
        "Faltou so travar o nome correto. Numero da lista ou redigitacao completa resolvem.",
        "Nao vou arriscar o nome sozinho. Escolha uma opcao ou redigite com sobrenome.",
        "Achei mais de um nome parecido. Pode responder com 1, 2 ou 3, ou redigitar.",
        "O quadro fica certo assim que voce confirmar o nome do medico.",
        "Cheguei perto, mas o nome ainda nao fechou. Escolha ou redigite por favor.",
        "Preciso de uma confirmacao rapida no nome antes de lancar.",
        "Base e horario ja ficaram claros. Falta so o nome completo do medico.",
        "Estou com opcoes proximas aqui. Pode escolher ou escrever o nome de novo.",
        "Para evitar lancamento errado, preciso que voce confirme o nome.",
        "Nao faltou quase nada. So preciso do nome certo para concluir.",
        "Consigo registrar agora mesmo, assim que voce confirmar o nome.",
        "A mensagem ficou boa, mas o nome ainda pede confirmacao.",
        "Pode me ajudar com o nome? Escolha da lista ou redigite nome e sobrenome.",
    ],
    name_unresolved: [
        "Preciso que voce redigite o nome do medico com nome e sobrenome.",
        "Esse nome ainda nao fechou com seguranca. Redigite, por favor, com nome e sobrenome.",
        "Pode mandar o nome de novo, com mais sobrenome? Assim eu registro certo.",
        "Ainda preciso que voce redigite o nome do medico de forma mais completa.",
        "Para eu lancar sem erro, redigite o nome com nome e sobrenome.",
        "O nome ficou curto para registro seguro. Pode redigitar mais completo?",
        "Redigite o nome, por favor. Nome e sobrenome ajudam a fechar certinho.",
        "Pode escrever o nome novamente com mais partes? Assim eu concluo sem risco.",
        "Ainda nao deu para cravar o medico. Redigite o nome completo, por favor.",
        "Preciso de uma nova redigitacao do nome, com sobrenome, para seguir.",
        "Mande o nome outra vez, por favor, com nome e sobrenome.",
        "Se puder, redigite o nome completo do medico para eu registrar agora.",
        "Estou precisando do nome redigitado com mais detalhe para concluir.",
        "Redigite o nome com calma, por favor. Nome e sobrenome resolvem.",
        "Ainda falta o nome completo do medico. Pode redigitar?",
        "Escreva o nome novamente com mais sobrenome, por favor.",
        "Pode reenviar o nome do medico de forma mais completa?",
        "Para seguir daqui, preciso que voce redigite o nome completo.",
        "Manda o nome de novo, por favor, com nome e sobrenome e o local do plantao.",
        "Ainda preciso de uma redigitacao mais completa do nome para registrar direito.",
    ],
    command_forbidden: [
        "Esse comando fica restrito a chefia e administracao. Se precisar, chame um chefe para ajustar por aqui.",
        "Nao consigo aceitar esse comando sem permissao de chefia. Se for o caso, acione um chefe para fazer a correcao.",
        "Esse tipo de ajuste exige perfil de chefia. Quando quiser, um chefe pode executar o comando corretamente.",
        "Por seguranca, esse comando so funciona para chefes ou admins. Peça a um responsavel para rodar por aqui.",
        "Eu nao consigo aplicar esse comando para perfis sem permissao de chefia. Melhor chamar quem esteja autorizado.",
    ],
    command_usage: [
        "Nao entendi o comando inteiro. Use o formato {usage}.",
        "Faltou alguma parte do comando. O formato esperado eh {usage}.",
        "Para eu executar certinho, manda assim: {usage}.",
        "Esse comando precisa vir no formato {usage}.",
        "Ainda nao deu para aplicar. Tente novamente como {usage}.",
    ],
    command_corrected: [
        "Correcao aplicada em {target}: {name} ficou registrado com chegada as {time}.",
        "Atualizei {target}. Agora consta {name} com chegada real as {time}.",
        "Feito. {target} foi corrigido para {name} as {time}.",
        "Correcao salva: {name} ficou em {target} com horario de chegada {time}.",
        "Pronto. Ajustei {target} para {name}, considerando {time} como chegada real.",
    ],
    command_removed: [
        "Retirei {name} de {target} com saida as {time}.",
        "Saida manual aplicada em {target}: {name} foi retirado as {time}.",
        "Fechado. {name} saiu de {target} as {time} e o painel foi atualizado.",
        "Retirada concluida em {target}. Considerei {time} como horario de saida de {name}.",
        "Pronto. Removi {name} do painel de {target} a partir de {time}.",
    ],
    command_deleted: [
        "Apaguei o registro de {name} em {target} da memoria operacional.",
        "Remocao completa feita em {target}. O registro de {name} foi descartado.",
        "Feito. Exclui o lancamento de {name} em {target} da memoria do sistema.",
        "Registro removido por completo: {name} em {target} nao fica mais salvo por aqui.",
        "Pronto. O lancamento de {name} em {target} foi apagado da memoria operacional.",
    ],
    casual_smalltalk: [
        "Bom plantao por ai.",
        "Tudo certo por aqui. Bom turno.",
        "Boa jornada para voces.",
        "Seguimos juntos por aqui.",
        "Bom trabalho nesse comeco de turno.",
        "Que rode liso por ai.",
        "Boa passagem de plantao para a equipe.",
        "Plantao tranquilo para todos.",
        "Tudo em ordem. Bom servico.",
        "Boa tocada por ai.",
        "Que seja um turno leve.",
        "Bom ritmo de trabalho hoje.",
        "Otimo plantao para a equipe.",
        "Que venha um plantao redondo.",
        "Boa energia por ai.",
        "Tudo alinhado. Bom plantao.",
        "Que seja uma jornada serena.",
        "Firme na missao. Bom plantao.",
        "Boa hora de trabalho para todos.",
        "Seguimos atentos por aqui.",
        "Que corra tudo bem no turno.",
        "Boa condução de plantao por ai.",
        "Que seja um plantao organizado.",
        "Bom servico para a turma.",
        "Tudo certo. Boa rodada.",
        "Que o plantao renda bem.",
        "Bom plantao e boa fluidez por ai.",
        "Boa jornada para quem esta na linha.",
        "Que seja um turno bem encaixado.",
        "Trabalho bonito por ai hoje.",
    ],
};

const REPLY_PREFIX: Record<ReplyKind, string> = {
    arrival_recorded: ":)",
    continuation_recorded: ":)",
    departure_recorded: ":)",
    departure_adjusted: ":)",
    departure_justification_required: ":|",
    departure_not_found: ":/",
    departure_time_conflict: ":|",
    departure_missing_context: ":|",
    candidate_prompt: ":|",
    name_unresolved: ":/",
    command_forbidden: ":/",
    command_usage: ":/",
    command_corrected: ":)",
    command_removed: ":)",
    command_deleted: ":)",
    casual_smalltalk: "^^",
};

const GROUP_CORRECTION_ANNOUNCEMENTS = [
    ":)\nAjuste de bastidor concluido.\n{name} ficou em {target} desde {time}.",
    ":D\nAcerto feito nos bastidores.\nAgora consta {name} em {target} desde {time}.",
    "o/\nQuadro alinhado por aqui.\n{name} ficou marcado em {target} a partir de {time}.",
    "^^\nBastidor organizado.\n{name} passa a constar em {target} desde {time}.",
    ":)\nAcerto silencioso, quadro certo.\n{name} em {target} desde {time}.",
];

function interpolate(template: string, params: Record<string, string>) {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? "");
}

function formatCandidateList(candidates: NamedCandidate[]) {
    return candidates
        .slice(0, 3)
        .map((candidate, index) => `${index + 1}. ${candidate.fullName}`)
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

export function buildCandidatePromptReply(seed: string | number, candidates: NamedCandidate[]) {
    const intro = pickTelegramReply("candidate_prompt", seed, {});
    const list = formatCandidateList(candidates);
    return `${intro}\n\nMais proximos:\n${list}\n\nResponda com 1, 2 ou 3.\nSe preferir, redigite nome e sobrenome.`;
}

export function buildNameUnresolvedReply(seed: string | number, candidates: NamedCandidate[] = []) {
    const intro = pickTelegramReply("name_unresolved", seed, {});
    const suggestionBlock = candidates.length > 0
        ? `\n\nMais proximos:\n${formatCandidateList(candidates)}`
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
        ? `:) Conferi o lote. ${params.entries.length} lancamentos ficaram prontos para gravar.`
        : `:| Conferi o lote. ${params.entries.length} lancamentos ficaram prontos e ${params.issues.length} precisam de correcao antes de autorizar.`;

    const entryLines = params.entries.length === 0
        ? ""
        : `\n\nProntos para lancar:\n${params.entries.map((entry) => {
            const modeLabel = entry.mode === "continuation" ? "continua" : entry.timeLabel;
            const sectorLabel = entry.sector === "REGULATION" ? "REG" : "INT";
            return `${entry.lineNumber}. [${sectorLabel}] ${entry.targetCode} - ${entry.doctorName} - ${modeLabel}`;
        }).join("\n")}`;

    const issueLines = params.issues.length === 0
        ? ""
        : `\n\nCorrigir antes de autorizar:\n${params.issues.map((issue) => `${issue.lineNumber}. ${issue.reason} -> ${issue.rawLine}`).join("\n")}`;

    const footer = params.issues.length === 0
        ? "\n\nResponda CONFIRMAR para lancar tudo de uma vez ou CANCELAR para descartar este lote."
        : "\n\nReenvie o bloco corrigido. Quando tudo fechar, eu mostro a previa final e espero seu CONFIRMAR.";

    return `${header}${entryLines}${issueLines}${footer}`;
}

export function buildTelegramBatchApplyReply(params: {
    appliedCount: number;
    failed: Array<{ lineNumber: number; reason: string }>;
}) {
    if (params.failed.length === 0) {
        return `:) Lote autorizado e lancado. ${params.appliedCount} registros foram gravados.`;
    }

    return `:| Lancei ${params.appliedCount} registros do lote, mas ${params.failed.length} falharam na hora de gravar:\n${params.failed.map((item) => `${item.lineNumber}. ${item.reason}`).join("\n")}`;
}