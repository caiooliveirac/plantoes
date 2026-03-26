type ReplyKind = "arrival_recorded" | "continuation_recorded" | "departure_recorded" | "candidate_prompt" | "name_unresolved" | "command_forbidden" | "command_usage" | "command_corrected" | "command_removed" | "command_deleted" | "casual_smalltalk";

interface NamedCandidate {
    fullName: string;
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