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
        "Chegada entendida.\n{name} ficou em {target} desde {time}.\nJá deixei isso no quadro.",
        "Tudo certo.\nRegistrei {name} em {target} as {time}.\nQuadro atualizado.",
        "Entrada confirmada.\n{name} assumiu {target} as {time}.\nRegistro salvo por aqui.",
        "Anotado.\n{name} ficou em {target} a partir de {time}.\nJá considerei essa cobertura.",
        "Fechou.\n{name} está em {target} desde {time}.\nDeixei o plantão alinhado no sistema.",
        "Recebi a chegada.\n{name} ficou marcado em {target} as {time}.\nTudo certo por aqui.",
        "Chegada registrada.\n{name} entrou em {target} as {time}.\nJá refleti isso no quadro.",
        "Confirmado.\n{name} ficou ativo em {target} desde {time}.\nSem pendência nesta entrada.",
    ],
    arrival_p_recorded: [
        "Chegada em P entendida.\nRegistrei {name} em {target} desde {time}.\nVou considerar esta cobertura para este plantão e o próximo.",
        "Entrada em P confirmada.\n{name} ficou em {target} desde {time}.\nEssa cobertura já vale para o turno atual e o seguinte.",
        "Recebi como chegada em P.\n{name} está em {target} desde {time}.\nNa próxima virada eu já considero essa continuidade prevista.",
        "P registrado como entrada.\n{name} assumiu {target} as {time}.\nVou levar isso para este plantão e para o próximo.",
        "Tudo certo com o P.\n{name} ficou em {target} desde {time}.\nA cobertura já entra como dupla no operacional, para este turno e o seguinte.",
        "Entrada em P salva.\n{name} está em {target} a partir de {time}.\nIsso já cobre o turno de agora e o seguinte.",
    ],
    half_shift_assumed: [
        "Supus que voce esta no meio plantao da tarde em {target}.\n{name} ficou registrado desde {time} e vou encerrar automaticamente as 17:00.\nNo pagamento, isso entra como MEIO.",
    ],
    continuation_recorded: [
        "Continuidade confirmada.\n{name} segue em {target} desde {time}.\nMantive a chegada original e só estendi a cobertura.",
        "Entendi como continua.\n{name} já estava em {target} desde {time}.\nNão tratei isso como nova entrada.",
        "Cobertura mantida.\n{name} continua em {target} desde {time}.\nPreservei o horário original de chegada.",
        "Tudo certo com a continuidade.\n{name} segue em {target} desde {time}.\nSó confirmei a manutenção do mesmo plantão.",
        "Continua registrado.\n{name} já constava em {target} desde {time}.\nAqui eu apenas mantive a mesma cobertura rodando.",
        "Recebi como continuidade.\n{name} continua em {target} desde {time}.\nA entrada original ficou preservada.",
    ],
    reassignment_recorded: [
        "Remanejamento registrado.\n{name} agora está em {target} desde {time}.\nOcupação anterior encerrada automaticamente.",
        "Troca anotada.\n{name} foi movido para {target} às {time}.\nO posto/base anterior já ficou liberado.",
        "Remanejamento confirmado.\n{name} assumiu {target} às {time}.\nA posição anterior foi encerrada.",
        "Mudança registrada.\n{name} passou para {target} às {time}.\nA ocupação de origem foi fechada.",
        "Tudo certo com o remanejamento.\n{name} agora consta em {target} desde {time}.\nOrigem liberada no quadro.",
        "Transferência feita.\n{name} está em {target} desde {time}.\nPosição anterior encerrada sem mexer em outros médicos.",
    ],
    departure_recorded: [
        "Saída registrada para {name} em {target} as {time}.",
        "Anotei a saída de {name} de {target} as {time}.",
        "Check-out confirmado: {name} deixou {target} as {time}.",
        "Tudo certo. {name} saiu de {target} as {time}.",
        "Saída salva: {name} em {target}, horário {time}.",
        "Registrei agora a saída de {name} de {target} as {time}.",
        "Perfeito, {name} encerrou {target} as {time}.",
        "Fechado. {name} encerrou a cobertura de {target} as {time}.",
        "Já deixei anotada a saída de {name} de {target} as {time}.",
        "Confirmado por aqui: {name} saiu de {target} as {time}.",
        "Certo. {name} teve a saída consolidada de {target} as {time}.",
        "Boa. Registrei a liberação de {name} em {target} as {time}.",
        "Saída confirmada para {name} em {target} as {time}.",
        "Atualizei o plantão: {name} deixou {target} as {time}.",
        "Ok, {name} encerrou o plantão em {target} às {time}.",
        "Anotado sem pendência: saída de {name} de {target} as {time}.",
        "Lancei a saída de {name} em {target}. Hora considerada: {time}.",
        "Registro feito. {name} encerrou em {target} as {time}.",
        "Tudo registrado: saída de {name}, {target}, {time}.",
        "Check-out salvo. {name} foi encerrado em {target} as {time}.",
    ],
    departure_adjusted: [
        "Ajustei a saída real de {name} em {target} para {time}. Mantive o painel com quem assumiu e atualizei pagamento e banco de horas.",
        "Considerei {time} como saída real de {name} em {target}. O painel segue com a rendição e o horário foi para pagamento e banco de horas.",
        "Saída tardia de {name} alinhada em {target}: hora real {time}. Não mexi em quem assumiu no painel e atualizei banco de horas.",
        "Feito. {name} ficou com saída real às {time} em {target}, sem tirar a rendição do painel e com reflexo em pagamento.",
        "Atualizei a saída de {name} em {target} para {time}. Painel preservado, horário real ajustado para pagamento.",
    ],
    half_shift_already_closed: [
        "Eu ja tinha tirado {name} do painel as 17:00 em {target}.\nEsse meio plantao fecha automatico no horario e ja foi registrado como MEIO para pagamento.\nPor enquanto nao tem banco de horas para essa funcao: a saida prevista era 17:00, distribuindo as ocorrencias.",
    ],
    departure_justification_required: [
        "Entendi a saída tardia de {name} em {target}, mas aqui já havia rendição e só considero minutos extras para pagamento e banco de horas com motivo válido por escrito.\n\n🚑 Em ocorrência\nEx.: estava em ocorrência 0729\n\n🧼 Higienizando\nEx.: estava higienizando a viatura\n\nSe o horário {time} está certo, responda só com um desses motivos. Se o horário mudou, reenvie a saída completa assim: {example}",
        "Como já havia outro médico em {target}, eu só consigo considerar essa saída tardia de {name} para pagamento e banco de horas com um destes motivos:\n\n🚑 Em ocorrência\nEx.: em atendimento de ocorrência 0729\n\n🧼 Higienizando\nEx.: em higienização da viatura\n\nSe {time} está correto, responda apenas o motivo. Se precisar trocar o horário, reenvie tudo assim: {example}",
        "A saída de {name} em {target} foi entendida, mas para crédito automático desse atraso eu aceito só dois motivos:\n\n🚑 Em ocorrência\nEx.: ainda em ocorrência 0729\n\n🧼 Higienizando\nEx.: finalizando higienização da ambulância\n\nSe o horário já está certo, responda aqui só com o motivo. Se o horário mudou, mande a saída completa assim: {example}",
        "Consigo revisar essa saída tardia de {name} em {target}, mas só entram para pagamento e banco de horas justificativas de um destes tipos:\n\n🚑 Em ocorrência\nEx.: estava em ocorrência\n\n🧼 Higienizando\nEx.: estava higienizando a viatura\n\nSe quiser manter {time}, responda só com o motivo. Se precisar alterar o horário, reenvie a linha completa assim: {example}",
        "Falta só validar o motivo da saída tardia de {name} em {target}. Para considerar minutos extras eu aceito apenas:\n\n🚑 Em ocorrência\nEx.: em ocorrência 0729\n\n🧼 Higienizando\nEx.: em higienização da viatura\n\nSe o horário está certo, responda só com um desses motivos. Se precisar corrigir o horário, reenvie a saída completa assim: {example}",
    ],
    departure_justification_retry: [
        "Ainda não consegui reconhecer um motivo válido para crédito automático dessa saída tardia de {name} em {target}.\n\n🚑 Em ocorrência\nEx.: estava em ocorrência 0729\n\n🧼 Higienizando\nEx.: estava higienizando a viatura\n\nPode tentar explicar mais uma vez só com o motivo. Se eu ainda não conseguir confirmar ocorrência ou higienização, deixo a justificativa salva para coordenação, mas sem crédito automático e só a chefia poderá lançar esses minutos extras.",
        "O motivo que chegou ainda não fechou como ocorrência ou higienização para a saída tardia de {name} em {target}.\n\n🚑 Em ocorrência\nEx.: em atendimento de ocorrência 0729\n\n🧼 Higienizando\nEx.: em higienização da viatura\n\nMe responda mais uma vez só com o motivo. Se eu não conseguir validar, a explicação fica registrada para coordenação, mas sem crédito automático e com lançamento extra apenas pela chefia.",
        "Para crédito automático dessa saída tardia em {target}, eu ainda preciso reconhecer um destes dois motivos:\n\n🚑 Em ocorrência\nEx.: ainda em ocorrência 0729\n\n🧼 Higienizando\nEx.: finalizando higienização da ambulância\n\nPode tentar mais uma vez. Se eu continuar sem certeza, salvo a justificativa para coordenação, mas sem pagar banco de horas automaticamente e com ajuste extra só pela chefia.",
    ],
    departure_occurrence_number_required: [
        "Entendi que {name} saiu tarde de {target} por ocorrência. Para creditar esses minutos no banco de horas eu preciso saber QUAL ocorrência — me responda só com o número dela (4 dígitos).\n\nEx.: ocorrência 4521\n\nSe o horário {time} mudou, reenvie a saída completa assim: {example}",
        "Saída tardia de {name} em {target} por ocorrência registrada. Falta só o número da ocorrência (4 dígitos) para eu lançar no banco de horas. Responda apenas o número.\n\nEx.: 4521\n\nSe precisar corrigir o horário {time}, reenvie tudo assim: {example}",
        "Para creditar a saída tardia de {name} em {target} por ocorrência, preciso do número da ocorrência (4 dígitos). Me mande só o número.\n\nEx.: estava na ocorrência 0729\n\nSe o horário {time} estiver errado, reenvie a saída completa: {example}",
    ],
    departure_occurrence_number_retry: [
        "Ainda não recebi o número da ocorrência (4 dígitos) de {name} em {target}. Responda só com o número.\n\nEx.: 4521\n\nSe eu continuar sem o número, deixo a saída registrada para a chefia revisar, mas sem crédito automático no banco de horas.",
        "Esse não parece ser o número da ocorrência. Preciso de 4 dígitos para creditar a saída tardia de {name} em {target}.\n\nEx.: ocorrência 0729\n\nSem o número, a saída fica para a chefia decidir e não entra como crédito automático.",
    ],
    departure_justification_recorded: [
        "Justificativa recebida. Anexei o motivo à saída de {name} em {target} às {time}. Isso já ficou registrado para a coordenação, pagamento e banco de horas.",
        "Motivo recebido e salvo. A saída de {name} em {target} ficou com justificativa anexada às {time}. A coordenação consegue ver essa explicação junto do registro.",
        "Perfeito. Guardei a justificativa da saída de {name} em {target} às {time}. Ela segue junto para coordenação, pagamento e banco de horas.",
        "Justificativa salva com sucesso. A saída de {name} em {target} às {time} agora ficou acompanhada do motivo para a coordenação conferir.",
        "Tudo certo. Registrei a justificativa da saída de {name} em {target} às {time}. Esse motivo já vai junto no fluxo da coordenação e do banco de horas.",
    ],
    departure_justification_manual_review: [
        "Guardei a justificativa da saída de {name} em {target} às {time} para coordenação, mas não consegui validar ocorrência ou higienização com segurança. Por isso, os minutos extras ficaram sem crédito automático. Se esse extra precisar entrar, só a chefia de plantão poderá lançar.",
        "Anexei a explicação da saída de {name} em {target} às {time} para a coordenação revisar. Como eu não confirmei ocorrência nem higienização com segurança, não deixei crédito automático de banco de horas. Nesse caso, só a chefia pode lançar os minutos extras.",
        "A justificativa de {name} em {target} às {time} ficou salva para conferência da coordenação. Como o motivo não fechou com segurança como ocorrência ou higienização, não houve crédito automático. Se for necessário lançar esse extra, fica a cargo da chefia.",
    ],
    departure_not_found: [
        "Entendi a saída de {name} em {target}, mas não achei ocupação compatível para fechar por aqui. Se a saída real foi diferente da rendição, reenvie assim: {example}",
        "A saída de {name} em {target} foi entendida, mas não encontrei plantão aberto ou recente para esse médico nesse local. Tente: {example}",
        "Li sua saída em {target}, só que não achei o registro operacional correspondente. Se precisar ajustar horário real, mande: {example}",
        "Não ignorei a mensagem, mas ainda não achei o plantão certo de {name} em {target}. Reenvie no formato: {example}",
        "Entendi a tentativa de saída em {target}, mas preciso de um reenvio mais completo para localizar o registro. Ex.: {example}",
    ],
    departure_time_conflict: [
        "Entendi a saída de {name} em {target}, mas esse horário ficou antes da chegada registrada. Reenvie com o horário certo. Ex.: {example}",
        "A saída de {name} em {target} veio com horário anterior à chegada salva. Mande de novo no formato: {example}",
        "Não consegui usar esse horário de saída em {target} porque ele ficou antes da entrada registrada. Pode reenviar assim: {example}",
        "Esse horário de saída de {name} em {target} conflita com a chegada registrada. Reenvie com o horário correto. Ex.: {example}",
        "A cronologia dessa saída em {target} não fechou. Me mande novamente com o horário certo. Ex.: {example}",
    ],
    departure_missing_context: [
        "Entendi que você quis registrar uma saída, mas faltou base ou horário. Reenvie assim: {example}",
        "Para eu lançar a saída, preciso do local e do horário na mesma mensagem. Ex.: {example}",
        "A intenção de saída ficou clara, mas ainda faltam dados para registrar. Pode mandar assim: {example}",
        "Consigo registrar essa saída se você reenviar com nome, base e horário. Ex.: {example}",
        "Faltou contexto para eu fechar a saída agora. Reenvie no formato: {example}",
    ],
    no_operational_match: [
        "Recebi sua mensagem, mas não consegui identificar uma ação operacional nela.\n\n📌 Para CHEGADA, mande no formato:\n{arrivalExample}\n\n📌 Para SAÍDA, mande no formato:\n{departureExample}\n\nSe precisar de ajuda, mande /ajuda.",
        "Li sua mensagem, mas não encontrei dados de plantão para registrar.\n\n📌 Para registrar CHEGADA, use este formato:\n{arrivalExample}\n\n📌 Para registrar SAÍDA, use este formato:\n{departureExample}\n\nQualquer dúvida, mande /ajuda.",
        "Não consegui entender essa mensagem como registro operacional.\n\n📌 CHEGADA — envie assim:\n{arrivalExample}\n\n📌 SAÍDA — envie assim:\n{departureExample}\n\nSe algo ficou diferente do esperado, tente reenviar no formato acima.",
        "Sua mensagem chegou, mas não identifiquei base, ramal ou horário nela.\n\n📌 Para CHEGADA, o formato é:\n{arrivalExample}\n\n📌 Para SAÍDA, o formato é:\n{departureExample}\n\nSe ficou na dúvida, mande /ajuda para ver os formatos aceitos.",
        "Entendi que você mandou uma mensagem, mas não consegui extrair dados operacionais.\n\n📌 CHEGADA — exemplo:\n{arrivalExample}\n\n📌 SAÍDA — exemplo:\n{departureExample}\n\nSe precisar, reenvie com nome, base/ramal e horário.",
    ],
    candidate_prompt: [
        "Falta só fechar o nome do médico. Escolha uma opção abaixo ou redigite o nome completo.",
        "Entendi base, horário e ação. Agora preciso que você confirme o nome do médico.",
        "Encontrei nomes parecidos. Escolha um número ou redigite nome e sobrenome.",
        "Para eu lançar certo, preciso confirmar o nome. Pode escolher da lista ou redigitar.",
        "O plantão eu entendi. O nome ainda precisa de confirmação.",
        "Antes de registrar, preciso bater o nome do médico. Escolha ou redigite.",
        "Tenho algumas opções próximas. Me diga qual é a certa ou mande o nome completo.",
        "Faltou só travar o nome correto. Número da lista ou redigitação completa resolvem.",
        "Não vou arriscar o nome sozinho. Escolha uma opção ou redigite com sobrenome.",
        "Achei mais de um nome parecido. Pode responder com 1, 2 ou 3, ou redigitar.",
        "O quadro fica certo assim que você confirmar o nome do médico.",
        "Cheguei perto, mas o nome ainda não fechou. Escolha ou redigite por favor.",
        "Preciso de uma confirmação rápida no nome antes de lançar.",
        "Base e horário já ficaram claros. Falta só o nome completo do médico.",
        "Estou com opções próximas aqui. Pode escolher ou escrever o nome de novo.",
        "Para evitar lançamento errado, preciso que você confirme o nome.",
        "Não faltou quase nada. Só preciso do nome certo para concluir.",
        "Consigo registrar agora mesmo, assim que você confirmar o nome.",
        "A mensagem ficou boa, mas o nome ainda pede confirmação.",
        "Pode me ajudar com o nome? Escolha da lista ou redigite nome e sobrenome.",
    ],
    name_unresolved: [
        "Preciso que você redigite o nome do médico com nome e sobrenome.",
        "Esse nome ainda não fechou com segurança. Redigite, por favor, com nome e sobrenome.",
        "Pode mandar o nome de novo, com mais sobrenome? Assim eu registro certo.",
        "Ainda preciso que você redigite o nome do médico de forma mais completa.",
        "Para eu lançar sem erro, redigite o nome com nome e sobrenome.",
        "O nome ficou curto para registro seguro. Pode redigitar mais completo?",
        "Redigite o nome, por favor. Nome e sobrenome ajudam a fechar certinho.",
        "Pode escrever o nome novamente com mais partes? Assim eu concluo sem risco.",
        "Ainda não deu para cravar o médico. Redigite o nome completo, por favor.",
        "Preciso de uma nova redigitação do nome, com sobrenome, para seguir.",
        "Mande o nome outra vez, por favor, com nome e sobrenome.",
        "Se puder, redigite o nome completo do médico para eu registrar agora.",
        "Estou precisando do nome redigitado com mais detalhe para concluir.",
        "Redigite o nome com calma, por favor. Nome e sobrenome resolvem.",
        "Ainda falta o nome completo do médico. Pode redigitar?",
        "Escreva o nome novamente com mais sobrenome, por favor.",
        "Pode reenviar o nome do médico de forma mais completa?",
        "Para seguir daqui, preciso que você redigite o nome completo.",
        "Manda o nome de novo, por favor, com nome e sobrenome e o local do plantão.",
        "Ainda preciso de uma redigitação mais completa do nome para registrar direito.",
    ],
    command_forbidden: [
        "Esse comando fica restrito à chefia e administração. Se precisar, chame um chefe para ajustar por aqui.",
        "Não consigo aceitar esse comando sem permissão de chefia. Se for o caso, acione um chefe para fazer a correção.",
        "Esse tipo de ajuste exige perfil de chefia. Quando quiser, um chefe pode executar o comando corretamente.",
        "Por segurança, esse comando só funciona para chefes ou admins. Peça a um responsável para rodar por aqui.",
        "Eu não consigo aplicar esse comando para perfis sem permissão de chefia. Melhor chamar quem esteja autorizado.",
    ],
    command_usage: [
        "Não entendi o comando inteiro. Use o formato {usage}.",
        "Faltou alguma parte do comando. O formato esperado é {usage}.",
        "Para eu executar certinho, mande assim: {usage}.",
        "Esse comando precisa vir no formato {usage}.",
        "Ainda não deu para aplicar. Tente novamente como {usage}.",
    ],
    command_corrected: [
        "Correção aplicada em {target}: {name} ficou registrado com chegada às {time}.",
        "Atualizei {target}. Agora consta {name} com chegada real às {time}.",
        "Feito. {target} foi corrigido para {name} as {time}.",
        "Correção salva: {name} ficou em {target} com horário de chegada {time}.",
        "Pronto. Ajustei {target} para {name}, considerando {time} como chegada real.",
    ],
    command_removed: [
        "Retirei {name} de {target} com saída às {time}.",
        "Saída manual aplicada em {target}: {name} foi retirado às {time}.",
        "Fechado. {name} saiu de {target} às {time} e o painel foi atualizado.",
        "Retirada concluída em {target}. Considerei {time} como horário de saída de {name}.",
        "Pronto. Removi {name} do painel de {target} a partir de {time}.",
    ],
    command_deleted: [
        "Apaguei o registro de {name} em {target} da memória operacional.",
        "Remoção completa feita em {target}. O registro de {name} foi descartado.",
        "Feito. Excluí o lançamento de {name} em {target} da memória do sistema.",
        "Registro removido por completo: {name} em {target} não fica mais salvo por aqui.",
        "Pronto. O lançamento de {name} em {target} foi apagado da memória operacional.",
    ],
    casual_smalltalk: [
        "Bom plantão por aí.",
        "Tudo certo por aqui. Bom turno.",
        "Boa jornada para vocês.",
        "Seguimos juntos por aqui.",
        "Bom trabalho nesse começo de turno.",
        "Que rode liso por aí.",
        "Boa passagem de plantão para a equipe.",
        "Plantão tranquilo para todos.",
        "Tudo em ordem. Bom serviço.",
        "Boa tocada por aí.",
        "Que seja um turno leve.",
        "Bom ritmo de trabalho hoje.",
        "Ótimo plantão para a equipe.",
        "Que venha um plantão redondo.",
        "Boa energia por aí.",
        "Tudo alinhado. Bom plantão.",
        "Que seja uma jornada serena.",
        "Firme na missão. Bom plantão.",
        "Boa hora de trabalho para todos.",
        "Seguimos atentos por aqui.",
        "Que corra tudo bem no turno.",
        "Boa condução de plantão por aí.",
        "Que seja um plantão organizado.",
        "Bom serviço para a turma.",
        "Tudo certo. Boa rodada.",
        "Que o plantão renda bem.",
        "Bom plantão e boa fluidez por aí.",
        "Boa jornada para quem está na linha.",
        "Que seja um turno bem encaixado.",
        "Trabalho bonito por aí hoje.",
    ],
};

const REPLY_PREFIX: Record<ReplyKind, string> = {
    arrival_recorded: "✅",
    arrival_p_recorded: "🔵🔁",
    half_shift_assumed: "🟠🌓",
    continuation_recorded: "🔵🔁",
    reassignment_recorded: "🔀",
    departure_recorded: "🔵📤",
    departure_adjusted: "🔵🛠️",
    half_shift_already_closed: "🟠⏱️",
    departure_justification_required: "⚠️",
    departure_justification_retry: "⚠️",
    departure_occurrence_number_required: "🚑🔢",
    departure_occurrence_number_retry: "🚑🔢",
    departure_justification_recorded: "📝✅",
    departure_justification_manual_review: "📝⚠️",
    departure_not_found: "⛔",
    departure_time_conflict: "⚠️",
    departure_missing_context: "⚠️",
    no_operational_match: "❓",
    candidate_prompt: "⚠️",
    name_unresolved: "⚠️",
    command_forbidden: "⛔",
    command_usage: "⚠️",
    command_corrected: "🔵🛠️",
    command_removed: "🔵📤",
    command_deleted: "🔵🗑️",
    casual_smalltalk: "💬",
};

const GROUP_CORRECTION_ANNOUNCEMENTS = [
    "🔵🛠️\nAjuste de bastidor concluído.\n{name} ficou em {target} desde {time}.",
    "🔵🛠️\nAcerto feito nos bastidores.\nAgora consta {name} em {target} desde {time}.",
    "🔵🛠️\nQuadro alinhado por aqui.\n{name} ficou marcado em {target} a partir de {time}.",
    "🔵🛠️\nBastidor organizado.\n{name} passa a constar em {target} desde {time}.",
    "🔵🛠️\nAcerto silencioso, quadro certo.\n{name} em {target} desde {time}.",
];

const CHIEF_KICK_ANNOUNCEMENTS = [
    "🔴👤\nSaída declarada pelo chefe de plantão.\n{name} saiu de {target} às {time}.",
    "🔴👤\nChefe de plantão registrou a saída.\n{name} encerrou em {target} às {time}.",
    "🔴👤\nSaída confirmada pela chefia.\n{name} deixou {target} às {time}.",
    "🔴👤\nRegistro de saída pela chefia.\n{name} saiu de {target} às {time}.",
    "🔴👤\nChefia declarou encerramento.\n{name} encerrou {target} às {time}.",
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
    if (context?.target) contextParts.push(`📍 ${context.target}`);
    if (context?.time) contextParts.push(`🕐 ${context.time}`);
    if (context?.shift) contextParts.push(`📋 ${context.shift}`);
    const contextLine = contextParts.length > 0 ? `\n\nDetectei: ${contextParts.join(" | ")}` : "";
    return `${intro}${contextLine}\n\nMais próximos:\n${list}\n\nResponda com 1, 2 ou 3.\nSe preferir, redigite nome e sobrenome.`;
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