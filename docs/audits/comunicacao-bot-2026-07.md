<!-- Gerado por auditoria multi-agente (13 agentes: inventário → crítica → verificação adversarial → síntese),
     com dados reais de produção coletados read-only em 14/07/2026.
     Nota do revisor: a ausência de parse_mode em modules/telegram/api.ts (sendMessage/editMessageText)
     foi verificada manualmente no código além da verificação dos agentes. -->

# Auditoria de comunicação — Bot de Telegram do SAMU (plantões)

**Data:** 14/07/2026 · **Base:** 30 dias de `telegram_ingested_messages` + `telegram_bot_notices` + inventário de balões verificado adversarialmente contra o código (`modules/telegram/*`). Findings reprovados na verificação foram descartados ou reformulados conforme as notas — cada um está marcado.

---

## 1. Resumo executivo

O bot processa ~90 registros aceitos/dia (2.743/30d), mas **rejeita ou ignora 810 mensagens/mês**, e os cinco maiores danos são autoinfligidos:

1. **Quem pede ajuda recebe silêncio:** a variante admin de `/comandos` tem 4.534 chars (> limite 4.096 do Telegram); a API rejeita, o catch só loga, e **6–8 pedidos de ajuda/mês não recebem resposta nenhuma** — a variante chief (3.688) está a 90% do teto.
2. **138 chegadas legítimas/30d bloqueadas** (2º maior motivo) pelo gate F6 por faltar SD/SN/P — mensagens como "Luan Sampaio 2035" têm nome+ramal claros e a única saída oferecida é redigitar tudo.
3. **O bot fabrica o próprio loop de erro:** o exemplo que ele ensina ("Vagner Costa PM04 07:00") **não tem turno** e é rejeitado pelo próprio F6. `no_operational_match` é o maior bucket (227/30d); uma médica tentou **8 formulações** sem nenhuma pista de que o problema era o código da base.
4. **Nenhuma mensagem renderiza formatação:** `sendMessage` nunca envia `parse_mode` (zero ocorrências no repo) — todos os `*asteriscos*` e `` `crases` `` chegam literais em ~3.700 mensagens/mês. A régua "dado-chave em negrito" é inexequível hoje.
5. **Refeição gera 79 erros de botão/30d** + repetições cegas ("2152 21:30" 3× seguidas, sem ack): o ack abre com o nome do médico **anterior**, o chamado enterra a vez sob piada sorteada, e o nudge repete o balão inteiro a cada 2 min com bronca pública, sem teclado e sem limite.

Somam-se 69 pendências mortas sem resposta (perguntas duplas + TTL não comunicado), 360 snapshots de cobertura de ~1.200 chars repetidos 6×/turno, e ~82 usos de `:/`/`:)` no lugar de emoji semântico.

---

## 2. Sistema de emoji semântico proposto

Vale para **todos** os balões: **1 emoji, sempre no início da 1ª linha, sempre o mesmo por significado**. Implementar estendendo o mapa `REPLY_PREFIX` já existente (`replies.ts:267-294`) — não criar módulo paralelo — e achatando os prefixos duplos (🔵🔁, 📝✅, 🟠🌓).

| Significado | Emoji | Substitui / aposenta |
|---|---|---|
| Registrado / deu certo | ✅ | `:)`, 🔵🛠️, 🔵🗑️, 📝✅ |
| Bloqueado / não deu | ⛔ | `:/` (~71× em service.ts), respostas sem prefixo |
| Precisa de ação **sua** | ⚠️ | 👀, 🚨, ⚠️ usado como "dica" ou "needs_review" |
| Remanejo / troca / continuidade | 🔁 | 🔀, 🔵🔁, 🚨 *ATENÇÃO* |
| Saída | 👋 | 🔵📤, 🔴👤, 👋 como saudação (remover) |
| Refeição | 🍽️ | ⚠️ nas sugestões de refeição |
| Lembrete / prazo / expirou | ⏰ | 📣, 🐢, 🙋 (leads de nudge) |
| Turno dia / noite | ☀️ / 🌙 | 🟠🌓 |
| Lista / relatório | 📋 | 🧭, 📤 (colisão /saidas × /prioridadesaida) |
| Pagamento | 💰 | — |
| Revisar (chefia) | 🔎 | ⚠️ no /saidas |
| Correção administrativa | 🛠️ | 🔵🛠️ (manter distinção visual, não colapsar em ✅) |
| Intervenção / Regulação | 🚑 / ☎️ | 📞 (aposentar; hoje convive com ☎️) |
| Herança de turno / sem aviso / desativada | 🟡 / 🔴 / ⚫ | 🔴 hoje significa herança E sem aviso no /plantao |

**Saem do sistema:** 🧭, 📤, 🫶, 🙂, 👀, 🚨, `:/`, `:)`, emojis decorativos no meio de linha, e a escala emotiva 🫶→⚠️→🚨 do snapshot (sempre ⚠️). Custo real: atualizar testes que asseram strings literais.

> **Pré-requisito de todas as reescritas com negrito/código:** habilitar `parse_mode` em `api.ts` (hoje ausente em `sendMessage`, `editMessageText`). **Não ligar globalmente**: templates atuais contêm `<base>`, `<Nome ou codinome>` literais (HTML rejeitaria) e entidade desbalanceada em Markdown descarta a mensagem inteira. Rollout: opt-in por callsite, helper de escape aplicado a **toda** interpolação (nomes do banco, display names do Telegram, tokens do parser), fallback obrigatório de reenvio sem parse_mode se a API rejeitar, e flag `TELEGRAM_PARSE_MODE` para desligar. Preferir HTML (escape determinístico) a Markdown v1.

---

## 3. Findings por área

### 3.1 Chegada e erros de registro

| # | Sev. | Ref | Problema | Evidência | Proposta |
|---|---|---|---|---|---|
| 1 | Crítico | `service.ts:10030` (gate F6) | Rejeita chegada com nome+ramal por faltar só o turno; balão de ~350 chars abre com retórica ("Quase lá") e exige redigitar tudo | 138/30d; "Luan Sampaio 2035", "MONICA NA 2031" | Não rejeitar: criar pendência com botões inline [☀️ SD] [🌙 SN] [P 24h] que completam o registro via callback (log.id no callback_data; parse já salvo em `resolutionData`). Manter caminho "meio plantão" (gate já aceita via `arrivalHalfShiftSatisfiesShiftGate`) e o bloqueio de payload de botão. Validar quem toca. **Sem inferência automática de turno** (reprovada: colide com P e meio plantão — ver §5.1) |
| 2 | Crítico | `service.ts:5220/5447` (/comandos) | Resposta > 4096 → API rejeita → silêncio; `markTelegramProcessed` ainda marca "accepted" antes do envio | 6–8 falhas/30d; admin 4.534 chars medidos | (a) Particionar em blocos ≤3.500 (reusar `packMessages`/`chunkTelegramLines`, já existem no repo); (b) rede de segurança no envio: resposta de ajuda nunca fica muda; (c) forma final: índice curto + botões por seção (revalidar role no callback) |
| 3 | Crítico | `buildTelegramArrivalExample` (`service.ts:858`) + `replies.ts:147` | O exemplo canônico não tem turno → quem obedece cai no F6. 5 variantes de "não entendi" impedem padrão | 227 no_operational_match/30d; caso das 8 tentativas | Corrigir o exemplo para sempre incluir turno (também em `/comandos:5246` e `/ajuda`); 1 template único ≤240 chars com formatos de chegada **e saída** (não perder o exemplo de saída das variantes atuais); preservar o apêndice `partialHint` |
| 4 | Alto | `service.ts:7123/7136/7142` (tomada de ramal) | Aviso de ~340 chars sem botão, não menciona a janela de **30 min**; anúncio do deslocado sem exemplo e sem reply_to | 29 pendências/30d, quase todas chegadas normais | Botões [✅ Assumir NNNN] [❌ Era outro ramal] + manter `confirmo NNNN` e reenvio exato como fallback; citar a janela de 30 min; guardar `senderTelegramId` no pending e validar o presser; anúncio como reply com exemplo de nova posição; preservar "sem ser marcado atrasado" |
| 5 | Alto | `replies.ts:340/351` (desambiguação de nome) | 20+20 variantes, instruções concorrentes, sem aviso de expiração; `name_unresolved` pede a mesma coisa 2× e lista candidatos sem teclado | 69 pending_expired/30d | 1 template, candidatos como **botões inline com nome completo**; copy do TTL deve dizer **30 min** (`PENDING_TTL_MS`, não 10); remover rodapé duplicado e frase sem acento (6900) |
| 6 | Alto | `replies.ts:93-121` + `service.ts:8676` (justificativa de saída tardia) | Escolha finita por texto livre em balão de ~450 chars com 2 ações; balão inteiro reenviado a cada mensagem casual; "só o número" contradiz o exemplo | 69 pending_expired inclui essas | Botões [🚑 Ocorrência] [🧼 Higienização] [Sem motivo]; 🚑 → "só os *4 dígitos*, ex.: `4521`"; [Sem motivo] fecha com semântica do manual_review + **notificar a chefia no privado** (hoje ninguém é avisado); mensagem casual durante pendência → lembrete de 1 linha |
| 7 | Alto *(reformulado)* | `service.ts:1582` (ramal ocupado) | Manda médico comum usar `/retirar` (gated → ⛔) e não mostra QUEM ocupa | Beco sem saída comprovado | **Não** prometer troca por reenvio (o erro só dispara no guard P2 de duração-zero — reenvio idêntico entra em loop): mostrar o ocupante e desde quando, dica de `/retirar` **só para chefe/admin**, e sugerir conferir o número do ramal / chamar a chefia |
| 8 | Alto *(reformulado)* | Sucesso (`service.ts:8348`) | Empilhamento de até 12 sufixos e "corrija: continuando" **dentro** do ✅ | ~90 sucessos/dia | Escopo corrigido: o caminho principal já suprime os hints (rule copy). Atacar só os call sites secundários (8541/9396/9732/9827); pedido de ação sai do ✅ e vira 2º balão; **preservar** a copy de FASE 1/2 e sufixos raros necessários (sombra, PIAM, reativação, plantão ~36h) |
| 9 | Médio | Parser de destino (GOA/GOS/2376) | Código desconhecido vira "não entendi" genérico — pior: o hint diz "faltou a base" a quem acabou de digitá-la | Caso das 8 tentativas; 2376 está a 1 edição de 2377 | Parser passa a expor o token rejeitado; resposta nomeia o código e sugere próximos por distância de edição (listas de `BASES_INTERVENCAO`/`RAMAIS_REGULACAO` ou do banco, nunca hardcoded na copy); botão de confirmação só quando o turno já está presente (senão encadeia 2ª pendência) |
| 10 | Médio | `service.ts:903` (COI 2 ramais) | ~640 chars, 7 emojis, exemplo 2×, para escolha binária | teto régua: 400 | ≤200 chars + botões [1367] [1368] que completam via o pending já existente (`pending_cru_coi_ramal`); CRU (muitos ramais) continua digitado |
| 11 | Médio | `service.ts:1574` (erro genérico) | Ecoa `errorMessage` interno cru (às vezes em inglês) | 68 status error/30d | Tabela de tradução erro→pt-BR com ação; cru só no log; caso "saída antes da chegada" deve mostrar a chegada registrada (plumbing novo p/ `replies.ts:133`) |
| 12 | Médio | `service.ts:10444` (PIAM SD/SN) | Pergunta binária por texto, sem pendência — "SD" solto depois vira no_operational_match | amostras confirmam | Botões [☀️ SD 07h–19h] [🌙 SN 19h–07h] + pendência; aceitar resposta textual como reply (requer `reply_to_message` no tipo `TelegramMessage` — mudança pequena) |
| 13 | Médio | `replies.ts:61` etc. (20-30 variantes por família) | Impossível formar padrão de leitura | régua nº 1 | 1 template fixo por família; em `departure_adjusted` **não perder** "o painel segue com quem assumiu" |
| 14 | Médio | Acentuação (`replies.ts:42`, `service.ts:8660/2083/6900`, meal-breaks) | Dezenas de strings sem acento | 7+ balões | Varredura única (parsers normalizam via NFD — seguro); incluir `tests/`; suprimir `halfShiftHint` quando a variante `half_shift_assumed` for usada (hoje duplica) |
| 15 | Médio | Botão "↩️ Desfazer" fora de contexto | Cai no genérico sem explicar | "muitas vezes" nos 227 | Interceptar `UNDO_TEXT` (e `CONFIRM_TEXT`) antes do parser; copy correta: o desfazer era **da divisão de refeição** já encerrada (não sugerir que registro operacional tem undo pelo chat) |
| 16 | Médio | `replies.ts:140` + `service.ts:880/10151` | Mesmo exemplo de saída 2× no mesmo balão; exemplo induz justificativa desnecessária | duplicação literal confirmada | Suprimir o hint estruturado quando a reply já tem `{example}`; tirar o "porque fui liberado…" do exemplo genérico |
| 17 | Baixo | Smalltalk durante pendência (`service.ts:8477-8488`) | Em grupo o bot **já silencia** (premissa parcial corrigida); o defeito real é responder smalltalk durante pendência de nome | 69 pending_expired | Nesse caminho, responder o lembrete da pendência em vez do smalltalk |
| 18 | Baixo | `service.ts:1586/7142` (gênero) | "Ana Beatriz … foi retirado" | sample confirmado | Forma neutra sem particípio flexionado + exemplo de nova posição (adição útil) |
| 19 | Baixo | Janela do botão SN↔P (`service.ts:8177`) | 2 min é curtíssimo; explicação do P sai até 3× no mesmo fluxo | `CONTINUITY_REVERT_TTL_MS` | Ampliar para 15 min (mecânica segura — `evaluateContinuityRevert` aceita `ttlMs` e a correção recalcula banco de horas); toque tardio **já tem** alert — só ajustar copy nas 2 menções a "2 min"; suprimir a frase duplicada no ✅; 📋→⚠️ |
| — | **Descartado** | Códigos de 6 dígitos no grupo ("225622") | Proposta reprovada: **não existe** código de pagamento de 6 dígitos (codinome é `bicho-pedra-123`); 6 dígitos soltos têm boa chance de ser **código de login do Telegram** — instruir a reenviá-lo em qualquer chat seria danoso | — | Follow-up: investigar o que são esses números antes de escrever qualquer copy |

**Reescritas-chave (chegada):**

> **F6 sem turno — ANTES** (~350 chars): "👀 Quase lá! Para registrar preciso de nome + local + turno. Faltou: *turno*… \[aula de formato\]"
> **DEPOIS** (≤200): "⚠️ Falta só o **turno** para registrar **Luan Sampaio** em **2035**.\nToque abaixo — ou reenvie: `Luan Sampaio 2035 SD 07:00`\n\[☀️ SD\] \[🌙 SN\] \[P 24h\]"

> **Tomada — ANTES** (~340 chars, 4 blocos, `confirmo 2034` em crase literal)
> **DEPOIS**: "⚠️ **2034** já está com **Kêmylla** (SD) desde **07:02**.\nVai assumir no lugar? Toque abaixo ou responda `confirmo 2034` em até **30 min**. A chegada dela fica preservada e ela pode declarar nova posição sem contar atraso.\n\[✅ Assumir 2034\] \[❌ Era outro ramal\]"

> **Não entendi — DEPOIS** (1 template): "⛔ Não entendi como registro de plantão.\nChegada: `Vagner Costa 1363 SD 07:00`\nSaída: `Vagner Costa saindo 1363 19:00`\nDúvida? Mande /ajuda" *(+ partialHint quando houver diagnóstico parcial)*

### 3.2 Refeição (meal-breaks)

*(O redesenho do chamado está na seção 4; aqui, o restante.)*

| # | Sev. | Ref | Problema | Evidência | Proposta |
|---|---|---|---|---|---|
| 1 | Crítico | `meal-breaks.ts:3630/3776/4134/4290` | Ack + convocação no **mesmo balão**: abre com o nome do médico anterior — quem lê no relance vê o nome errado | 60 button_outside_flow + 11 reply_invalid/30d | Separar em 2 balões (o dispatcher já envia `messages[]` com teclado só no último — trocar o `join` por 2 entradas): balão 1 "✅ **Bruno Lima** → almoço **12:30**" (jantar preserva a duração 1h/30min); balão 2 = convocação. Com inline keyboard: ack via `answerCallbackQuery` e só a convocação no grupo |
| 2 | Alto | `meal-breaks.ts:1318` (reply keyboard) | Teclado do grupo inteiro com payload literal "NNNN HH:MM": qualquer um escolhe pelo colega, teclado velho gera erro, sessão fechada vira tentativa de chegada; **nudge sai sem teclado** | 79 erros/30d; undo sem checagem de autor (3434) | Migrar para **inline keyboard** (`callback_data` = modo+data+ramal+slot, cabe em 64B — sessão não tem uuid): fora de sessão → alert "⛔ Essa divisão já fechou"; fechar fase → `editMessageText` remove teclado morto; callback identifica o autor (undo restrito ao autor/chefia — exige gravar `actorTelegramId` no snapshot); **gravar log equivalente em `telegramIngestedMessages`** (callback não gera mensagem — auditoria não pode perder a escolha); manter parse textual como fallback na transição; migrar `CONFIRM_TEXT`/`UNDO_TEXT` junto |
| 3 | Alto | `meal-breaks.ts:1431/1445` + `:264` (nudge) | Reenvia o anúncio inteiro a cada **2 min**, sem teto, com bronca pública sorteada | 53 nudges/30d | Nudge curto (⏰ fixo, com teclado reanexado); escalonamento 3 min → 8 min ("última chamada") → 12 min **pula a vez** (⚠️ mudança de regra de negócio — decidir com a operação) + DM à chefia (só chega a chefe que já abriu o bot); apagar o nudge anterior (`deleteMessage` **não existe** em api.ts — criar wrapper e guardar message_id) |
| 4 | Médio | `meal-breaks.ts:1478` (fora da vez) | Nome da vez 2×, sem posição do autor, teclado reanexado à pessoa errada | 11 reply_invalid | "⛔ Ainda não é sua vez — agora é **Ana Souza** (1363). Você é o **3º** da fila; eu te chamo." Posição calculada pelo **ramal digitado** (não há vínculo telegram↔médico), com fallback se o ramal não está na fila; sem teclado nesta resposta |
| 5 | Médio | `meal-breaks.ts:3348+` (transição de fase) | 3 balões/~730 chars; convocação empurrada p/ fora da tela; resumo duplicado | 2×/dia por grupo | 1 balão: "✅ **Almoço fechado** — resumo completo no fim" + convocação do descanso; regras "14:30 auto/18:00 fixo" viram legenda no resumo final, **mantendo a lista nominal** de quem caiu nelas |
| 6 | Médio | `meal-breaks.ts:4026/4107` + 6 outros | Recusas de formato/slot em 7 redações, sem emoji, template abstrato | repetição do mesmo autor | 2 templates com o ramal real da vez interpolado: "⛔ Não entendi. Responda: `1363 11:30`" / "⛔ **12:30** lotou. Livres: **11:30** (1 vaga) · **13:30** (2). Responda: `1363 11:30`"; distinguir "não existe nesta fase" de "lotou" |
| 7 | Médio | `meal-breaks.ts:1409/3813/4069` (jargões) | RECIP/MRV/COI/"painel" sem tradução; pergunta finita sem botões | 6 balões | 1ª ocorrência de sigla ganha tradução entre parênteses; RECIP com botões de ramais candidatos (precedente: teclado de MRV manual); realocações destacam o horário final; "painel" → o site (`AUTH_URL`, não hardcode) |
| 8 | Médio | `meal-breaks.ts:5221/5232` (Error cru) | Exceção vaza `Error.message` pro grupo | throw de 4805 vaza | Mapear erros conhecidos com **classe/código próprio** (não substring); técnico só ao admin no privado (`sendPrivateAdminAlert` existe); preservar as copies intencionais tipo "1379 não entra na divisão" (não são vazamento) |
| 9 | Médio | `meal-breaks.ts:4505` (/prioridade) | Tabela de pipes ilegível no mobile; jargão RMT/IES | ~500 chars | 1 entrada/linha sem pipes, "chegou 07:02", jargão traduzido **na fonte** (camada de prioridade); cabeçalho neutro "ordem de prioridade" (a ordem não é só chegada) |
| 10 | Médio | `meal-breaks.ts:1640/3466` (confirmação) | Qualquer um aperta "✅ Confirmar" pela chefia; pós-confirmação oferece "reiniciar" 1s depois; notação sem legenda | inventário | Restringir confirmação à chefia **com fallback** (liberar para todos após N min — a lista de IDs é env estática e chefes rotativos podem faltar; hoje "qualquer um" é o que destrava as aberturas automáticas de 9h/20h); exige inline ou checagem de sender; manter horários do PSIQ e decidir destino do bloco 🛡️ antes de cortar |
| 11 | Baixo | `meal-breaks.ts:1549/1666` (balões-fantasma) | "Divisao encerrada." (18 chars) em corrida, sem contexto | undo/nudge | Distinguir **fase** concluída de **sessão** concluída; nudge de corrida: re-checar o head antes do envio e suprimir |
| 12 | Baixo | Lote de consistência | Arquivo inteiro sem acentos; `:/`; "foi retirado"; data ISO | 4 classes | Passada única junto das reescritas; "está fora da divisão de hoje" (neutro — é ato da chefia via /excluir); datas DD/MM; `AUTH_URL` no aviso admin |

### 3.3 Lembretes e relatórios

| # | Sev. | Ref | Problema | Evidência | Proposta |
|---|---|---|---|---|---|
| 1 | Crítico | `reminders.ts:504` (coverage_snapshot) | 6 balões de ~1.200 chars/turno repetindo o quadro inteiro a cada 10 min — treina o grupo a ignorar o bot | **360 envios/mês** (maior volume) | Quadro completo só no 1º snapshot do turno; do 2º ao 6º **apenas o delta** de pendências (payload jsonb do notice compara com o bucket anterior); suprimir se nada mudou; sempre ⚠️ (aposentar 🫶→⚠️→🚨); exemplos copiáveis de "quem está no posto" e "quem emenda" |
| 2 | Alto | `reminders.ts:589` (payment_checkpoint) | Snapshot de auditoria de ~1.430 chars 2×/dia no **grupo** (que não pode agir), inclusive à meia-noite | 150/mês | Íntegra só ao privado dos admins (nas 2 edições); grupo: nada às 00:00; às 12:00 só se houver pendência, ≤160 chars com exemplo copiável; dois planos com noticeKeys distintos (padrão já existe) |
| 3 | Alto | `reminders.ts:761` (payment_conflict_alert) | Jargão 100% interno ("titulares", "sombra") + URL admin no grupo a cada 2h | 84/mês | Só privado de admins/chefes; 1 linha por conflito; eco público opcional de 1 linha neutra |
| 4 | Alto | `reminders.ts:547` (coverage_checkpoint) | Chega ~10 min após o 6º snapshot com o mesmo conteúdo (~2.300 chars duplicados em 10 min) | 60/mês | Fundir: o snapshot das 08:00/20:00 vira o fechamento, invertido (pendências primeiro, confirmados como contagem, lista completa no /plantao) |
| 5 | Alto | `reminders.ts:181` (takeover_conflict_alert) | Re-spam grupo+admins+chefes a cada 10 min com jargão e URL admin | por bucket, janela toda | Só privado de chefes/admins (mudança local de recipients); 1 linha com os dois nomes + minutos pendentes |
| 6 | Médio | `reminders.ts:461` (instruction pré-turno) | ~500 chars, 2 ideias, 🧭 colidindo com snapshot | 60/mês | ≤240 chars: formato único + exemplo de chegada e de continuação + consequência ("sem aviso, a posição fica sem médico no quadro"); ⏰ |
| 7 | Médio | `reminders.ts:647/681` (regulation_confirmation) | Checagem de chefia postada 177×/mês no grupo com regra interna de contagem; variante privada em CAIXA ALTA sem ação | 177/mês | Contagens/regras só no privado da chefia; grupo só quando falta gente, com 1 ação; corrigir wording do piso (gatilho é ≤8 → "mínimo 9") |
| 8 | Médio | `shift-report.ts:206` (/plantao) | ~1.760 chars; preâmbulo de documentação; **🔴=herança na intervenção mas 🟡=herança na regulação** (e 🔴 também=sem aviso) | risco de 4096 | Pendências primeiro com "veio de SN, continua?" embutido + exemplo copiável; confirmados compactos (manter marca **P** por linha e hora/motivo das desativadas); 🟡 herança / 🔴 sem aviso em ambos os domínios |
| 9 | Médio | `departure-report.ts:224` (/saidas) | Relatório financeiro de ~1.870 chars em pipes no grupo, com linha-legenda para se explicar | perto de 4096 | No grupo: resumo de 3 linhas; íntegra no privado de quem pediu — **decisão explícita do dono**: /saidas hoje é público, restringir a íntegra a chefe/admin muda acesso; fallback p/ 403 ("me chame no privado"); 🔎 para revisar |
| 10 | Médio | `departure-priority.ts:335` (/prioridadesaida) | Ranking só depois de ~380 chars de preâmbulo com siglas | 3 comandos inventados p/ chegar nele | Ranking na linha 2; regras colapsadas em 1 linha no rodapé; **manter** a linha da janela ativa do jantar no SN; 👋 |
| 11 | Médio | `service.ts:4991/5032/5076` + usages | `error.message` cru pro grupo; `:/`; usage estilo man-page | 3 templates | Erro fixo por relatório (cru já fica no log); usages viram exemplos copiáveis |
| 12 | Médio *(reformulado)* | `late-arrival-prompt.ts:57/90` | 642 chars, sem acentos, "carryover", instrução de chefia respondida ao médico | asteriscos crus em produção | Reescrever **preservando**: (a) a conversão para MEIO é **condicional** ao reconhecimento (o rewrite original afirmava incondicional — reprovado); (b) branch para chegada ≥13:00 (sem carryover); (c) a via alternativa de reconhecimento pelo quadro, além do `/meioplantao` |
| 13 | Baixo | `reminders.ts:936` (half_shift_auto_checkout) | Sem acentos, "foi retirado", 🟠🕔 | diário às 17:00 | "⏰ **Meio plantão encerrado:** **{nome}** saiu de **{ramal}** às **{hora}** (automático). Já registrei para pagamento como MEIO." — interpolar `formatHour(endedAt)` (pode ser <17:00) |
| 14 | Baixo | `service.ts:8660` (cancelamento) | ⚠️ em desfecho informativo; "saida" 2× | verbatim | Prefixo neutro (não ✅ — deixaria o cancelamento parecer crédito registrado) |
| 15 | Baixo | `service.ts:10199` (doctor_not_resolved) | Typos bloqueiam sem oferecer os candidatos que o fuzzy já calculou | 17/30d | 1-3 candidatos como botões (já persistidos em `resolutionData` com cap 3); bônus de parser: quebrar "Syonefeitosa" antes do fuzzy |

### 3.4 Comandos e pagamento

| # | Sev. | Ref | Problema | Evidência | Proposta |
|---|---|---|---|---|---|
| 1 | Alto | `service.ts:3533/5791` (fallback de comando) | Comando desconhecido recebe sugestão de 3 relatórios, nunca o comando a 1 letra de distância | 24 command_parse_failed/30d | Fuzzy (Levenshtein ≤2, helper já existe no repo) + mapa de palavras: JANTA*/REFAZERJANTAR → /jantar; ORDEM*SAIDA*/PRIORIDADESAIDAS → /prioridadesaida; PLANTOA → /plantao; AJUDA → /ajuda. **Escopo corrigido pela verificação:** /SAIDAS e a maioria dos comandos de prefixo **já** aceitam caixa alta e @bot (regex `/i` + `(?:@\w+)?`); os órfãos reais de @sufixo são só os matchers de igualdade estrita — /ajuda, /comandos, /cobrar, /status, /meuturno e a família de `commands.ts:110`. Strip do @ **restrito ao username do próprio bot** (senão responde a comandos de outros bots). **Não** mapear /saida → /prioridadesaida (é alias documentado de /retirar) |
| 2 | Alto | `service.ts:5809` + `replies.ts:198` (command_forbidden) | Médico que manda "/saida PM04 19:00" (parseia como /retirar) leva "restrito à chefia — chame um chefe": orientação errada, ele registra a própria saída por texto | caso mais comum é o menos ajudado | Se alias de saída + remetente não-chefe: responder o formato texto-livre **semeado** com base/hora do parse. Demais restritos: 1 texto fixo |
| 3 | Alto | `replies.ts:351` + `command-suggestions.ts:208` | `name_unresolvedReply` lista candidatos numerados **sem criar pendência** — responder "1" cai no short_reply com jargão de sistema. (Nuance verificada: o balão de pendência `candidate_prompt` **aceita** 1/2/3 por 30 min — o problema lá é só a expiração) | 69 pending_expired; 17 doctor_not_resolved | Botões inline nos dois balões; short_reply neutro (não afirmar "expirou" quando nunca houve pendência); aviso proativo ao expirar pendência (cuidado com ruído em grupo); remover pedido de base/ramal no contexto de pagamento |
| 4 | Alto | `service.ts:5216` (/ajuda) | 1.135–1.465 chars, 5 assuntos, 2 dicas concorrentes; **o exemplo do próprio /ajuda seria rejeitado pelo F6** (sem turno) | medições confirmadas | ~400 chars: 1 exemplo copiável por ação (chegada/saída/emenda), todos com turno; chief/admin: +2 linhas (manter 1 linha de /pagamento p/ chief); pitfalls ("24h" como hora, mensagens separadas) permanecem no /comandos |
| 5 | Médio | `service.ts:4455/4439` (codinome/lock) | Não diz tentativas restantes nem que o lock dura **1 hora** — loop de retentativas | regras em `payment-access.ts:9-11` nunca comunicadas | "⛔ Codinome não confere — tentativa **{n} de 5** (na 5ª, trava por 1h)"; lock: "Libera às **{HH:MM}**" (expor `failedCount` no retorno; `lockedUntil` já existe; converter p/ SP) |
| 6 | Médio | `service.ts:4408` +9 pontos (Error cru) | 10 balões interpolam `error.message` cru; 4432 é beco sem saída | molde repetido | Texto fixo por ação, cru só no log — **com allowlist** (`UserFacingError`): o repo lança erros de negócio curados em pt que não podem ser suprimidos (ex.: 4831/correções) |
| 7 | Médio | `payment-digest.ts:153` + `service.ts:4477` | Total em R$ no **fim**, acima de URL de 150 chars; tags sem legenda; variante vazia manda folha vazia | 90 digests/mês | Total no cabeçalho + legenda de MEIO; **manter "(Feriado)"** (não dedutível da data e justifica tarifa); unificar as 2 variantes vazias (sem link) |
| 8 | Médio *(reformulado)* | `service.ts:3728` (/pagamento conferir) | REV misturado aos OK; códigos sem legenda; sem chunking | sample 1.108 chars | REV primeiro + legenda + `chunkTelegramLines(3500)`; **manter 1 linha por entrada pronta com nome + \[MEIO\]** (colapsar para só códigos apagaria exatamente o dado que o comando confere) e o bucket de desativadas |
| 9 | Médio | `service.ts:4422` (/pagamento no grupo) | Barra sem dar o caminho | usuários perdidos entre grupo/privado | Botão inline **url** para o privado do bot (estender o tipo de botão em api.ts; username via `getMe`/env, não hardcode); mesmo padrão p/ /resetcodinome |
| 10 | Médio | `service.ts:4400` vs `4580` (codinome 2 superfícies) | Formatos opostos; codinome nunca em código copiável | inventário | Texto canônico único; ambos usam `resetDoctorCodename` (devolve o anterior); "⚠️ O anterior parou de valer" condicional; copiável depende do parse_mode |
| 11 | Médio | Transversal `:/` (~71×) `:)` (11×) | Sem vocabulário visual | subestimado no finding | Grep mecânico → tabela da seção 2, estendendo `REPLY_PREFIX` |
| 12 | Médio | `service.ts:3475/9526` (1º contato privado) | Resposta fixa é pitch de /pagamento — não diz que registro é no grupo | confusão de canais em produção | Acrescentar "⚠️ Chegada e saída são registradas **no grupo**, não aqui"; validar no reuso em 4446 |
| 13 | Médio *(reformulado)* | `command-suggestions.ts:177` (sugestão refeição) | Gatilho exige substring exata "JANTAR" ('/JANTA' e 'REFAZER JANTA' caem no genérico que nem cita /jantar); ⚠️ em vez de 🍽️. **Reprovado:** "botão fora da vez não nomeia a vez" — o código já nomeia durante sessão ativa; fora de sessão não existe "vez" a nomear | 24 parse_failed | Só: trocar o gatilho pelos `MEAL_BREAK_KEYWORDS` do parser (JANT\w{0,5}, DESCANS*, REFEIC*) e reescrever a sugestão com 🍽️ |
| 14 | Baixo | `service.ts:5485` (/cobrar) | 579 chars com **nomes reais de médicos** hardcoded; fallback `?? "Vagner"` | medido | Nomes fictícios fixos; ~290 chars; **manter 1 linha de consequência** (o fecho atual agrega informação — a verificação corrigiu o "metade repete") |
| 15 | Baixo | `service.ts:4529` (resetar-todos) | Confirmação destrutiva em massa por redigitação, sem contagem | padrão gera pending_expired | Botões \[🔐 Confirmar reset de {n}\] \[Cancelar\] (expira 5 min; re-validar admin no callback; marcar consumo contra double-tap); pós: "entregue cada codinome no privado" |
| 16 | Baixo | `service.ts:4506` + `payment-commands.ts:51` | "estão só no seu txt"; `\|` com 2 significados no usage | verbatim | Legenda de "(sem registro)" + remédio; usage vira exemplo preenchido; "SD ou SN" em vez de `[SD\|SN]` |

---

## 4. Redesenho do chamado de refeição

**Dor explícita do dono: "não fica claro de quem é a vez".** Confirmado em código e produção — 79 erros de botão/30d, escolhas repetidas sem ack, 53 nudges com bronca.

**Mecânica atual** (`meal-breaks.ts:1451-1474`, `1318`, `1431-1447`, `4134` etc.):
1. Chamado de 5 linhas: emoji de fase + **piada sorteada na linha 2** + nome sem destaque + "Horarios livres" (duplica os botões) + exemplo sempre com o primeiro slot (induz aglomeração).
2. Ack da escolha anterior **cola na convocação seguinte** — o balão abre com o nome de quem já escolheu.
3. Reply keyboard do grupo inteiro: qualquer um aperta pelo colega; teclado velho → erro; sessão fechada → o payload vira tentativa de chegada; escolha repetida → **silêncio** (nenhum "já anotei").
4. Nudge a cada 2 min: anúncio inteiro de novo, sem teclado, sem teto, com bronca pública.

**Mecânica proposta:**
1. **Um balão por vez de fila**, sempre a última mensagem do grupo, nome na 1ª linha; ack separado (ou via `answerCallbackQuery`, sem balão).
2. **Inline keyboard** com vagas no rótulo; toque fora de hora → alert privado explicando ("essa divisão já fechou" / "agora é a vez de X"); fase fechada → `editMessageText` remove teclados mortos; undo restrito ao autor/chefia; **cada callback gravado em `telegramIngestedMessages`** (auditoria); fallback textual `ramal HH:MM` mantido.
3. **Dedupe com confirmação:** escolha idêntica repetida → "✅ Já anotei **2152 → 21:30**. Não precisa reenviar."
4. **Nudge escalonado:** 3 min (lembrete curto com teclado) → 8 min (última chamada) → 12 min pula a vez + avisa chefia no privado *(regra de negócio — validar com a operação)*; apagar o nudge anterior (requer wrapper `deleteMessage`, novo em api.ts).

**Balão final proposto** (~140 chars, 2 emojis fixos; 🍽️ almoço/jantar, 😴 descanso, 🌙 noturno; jantar mantém a duração):

> 🍽️ **É a vez de Ana Souza** — ramal **1363**
> Escolha o almoço nos botões, ou responda: `1363 11:30`
> ⏭️ Depois: Bruno Lima · faltam 5
> \[11:30 · 2 vagas\] \[12:00 · 1 vaga\] \[12:30 · 3 vagas\]

**Nudge:** "⏰ **Ana Souza** (ramal **1363**) — ainda falta escolher o almoço. Toque num botão ou responda: `1363 11:30`"

**Fora da vez:** "⛔ Ainda não é sua vez — agora é **Ana Souza** (1363). Você é o **3º** da fila; eu te chamo aqui."

⚠️ **Sequenciamento obrigatório:** o rótulo "11:30 · 2 vagas" só funciona **depois** da migração para inline — no reply keyboard atual o texto do botão É o payload parseado; mudar o rótulo antes quebra o parse e escapa da proteção anti-vazamento. Se a reescrita de texto sair antes, manter a linha de horários livres.

---

## 5. Erros de interpretação a corrigir (comportamento, não texto)

Priorizados por volume × dano:

1. **Chegada sem turno não deve morrer** (138/30d): virar pendência com botões SD/SN/P que completam o registro. **Não** inferir turno pelo horário — colide com P (também começa ~07:00; registrar como SD corta 12h da janela de pagamento) e com meio plantão. E o conserto "responda `P`" não funciona hoje: reenvio do mesmo médico cai no re-anúncio didático, que não troca turno.
2. **Resposta de ajuda nunca pode ficar muda:** `/comandos` admin = 4.534 chars > 4.096 → chunking (≤3.500, padrão já existe no repo) + rede de segurança no envio, **restrita** a "message is too long"/caminhos de comando (o catch de 10477 cobre todo o webhook — fallback indiscriminado duplicaria respostas).
3. **O exemplo canônico reprova no próprio parser:** `buildTelegramArrivalExample` sem turno (e o exemplo de "troca" do /comandos idem — é parseado como chegada nova, não reassignment). Correção de 1 linha, efeito em todos os balões que o interpolam.
4. **Botão fora de hora sem feedback** (79+/30d): interceptar `UNDO_TEXT`/`CONFIRM_TEXT` literais antes do parser de chegada; migração para inline dá o feedback via alert e elimina a classe.
5. **@bot e aliases:** strip do sufixo `@` **do próprio bot** nos matchers de igualdade estrita (/ajuda, /comandos, /cobrar, /status, /meuturno); aliases sem colisão (/janta, /refazerjantar, /ordemdesaida, /prioridadesaidas, /plantoa, /reiniciar); fuzzy no fallback. **Não tocar** /saida (alias de /retirar) nem /saidas (comando real que já funciona).
6. **Respostas curtas a pendência morta** ("SD", "12:30" → no_operational_match): rotear resposta curta do mesmo autor para pendência recente/expirada (janela ≤2h, revalidando contra o quadro), **depois** do handler de meal-break (colisão de "12:30" com slot); botões eliminam a maior parte.
7. **Destino desconhecido sem diagnóstico:** parser deve expor o token rejeitado; fuzzy contra postos/bases; limitar sugestão por distância (não chutar para "GOA").
8. **Tomada por reenvio textual exato** → botões + fallback digitado; pendência ganha `senderTelegramId` para validar o presser.
9. **`name_unresolved` não cria pendência** — responder "1" nunca teve como funcionar; botões nos dois balões.
10. **`error.message` cru no chat** (~15 pontos): allowlist de erros user-facing; cru só no log (já persistido).
11. **`parse_mode` ausente** — pré-requisito de tudo que usa negrito/código: opt-in por callsite, escape universal, fallback de reenvio.
12. **Escolha de refeição repetida = silêncio** → ack de dedupe.
13. **Janela de 2 min do botão SN↔P** → 15 min (`ttlMs` já parametrizado; correção recalcula banco de horas); atualizar as 2 copies que citam "2 min".
14. **Números de 6 dígitos no grupo:** *não* escrever copy ainda — investigar o que são (provável código de login do Telegram; a resposta proposta originalmente seria danosa).

---

## 6. Plano de ataque em 3 ondas

**Onda 1 — Texto puro, sem mudança de fluxo** *(esforço: P–M; risco quase nulo; maior parte é grep+reescrita+testes)*
- Chunking de `/comandos` (`packMessages` 3.500) + rede de segurança no envio de ajuda. **Mata a falha mais grave hoje.**
- Corrigir `buildTelegramArrivalExample` e todos os exemplos sem turno (/ajuda, /comandos).
- Tabela de emojis: estender `REPLY_PREFIX`, `:/`→⛔, `:)`→✅, achatar prefixos duplos, aposentar 🧭/📤/🫶/🚨/👀; 🟡/🔴 consistentes no /plantao.
- Varredura de acentuação (meal-breaks inteiro + service/replies) + gênero neutro + datas DD/MM.
- Reduzir famílias de 5–30 variantes a 1 template (saída, no_operational_match, candidate_prompt, smalltalk, forbidden).
- Suprimir duplicações literais (hint de saída 2×, halfShiftHint, explicação tripla do P).
- Textos de codinome/lock com contador e horário de liberação; unificar /resetcodinome + /pagamento codinome; nomes reais → fictícios (/cobrar, fallback "Vagner").
- Strip de @bot nos matchers estritos + aliases sem colisão + fuzzy no fallback de comando; gatilho de refeição por `MEAL_BREAK_KEYWORDS`.
- command_forbidden de /saida semeado com o formato texto-livre.
- Interceptar UNDO_TEXT/CONFIRM_TEXT fora de sessão com resposta específica.
- Reescritas de reminders sem retarget: instruction, half_shift_auto_checkout, cancelamento (8660), late-arrival (com condicionalidade e branch ≥13h preservados).

**Onda 2 — Botões, pendências e retarget** *(esforço: M–G; exige parse_mode primeiro)*
- `parse_mode` opt-in por callsite + escape universal + fallback + flag de rollback. *(pré-requisito do valor das reescritas)*
- Botões inline: F6 SD/SN/P · tomada (✅/❌ + janela de 30 min no texto + senderTelegramId no pending) · candidatos de nome (2 balões) · justificativa de saída (🚑/🧼/sem motivo + notificação à chefia) · PIAM SD/SN (com pendência + reply_to_message no tipo) · COI 1367/1368 · doctor_not_resolved · resetar-todos com contagem · botão-url para o privado em /pagamento.
- Reabertura de pendência expirada por resposta curta do mesmo autor (após handler de meal-break; revalidar quadro).
- Destino desconhecido: parser expõe token + fuzzy + listas do banco.
- Erros: tabela de tradução (1574), allowlist UserFacingError nos 10 moldes de pagamento, mapeamento por classe no meal-breaks.
- Relatórios/lembretes: snapshot em delta + supressão · payment_checkpoint e payment_conflict_alert só no privado · fusão checkpoint/snapshot · regulation_confirmation retarget · /plantao, /saidas (com decisão do dono sobre acesso), /prioridadesaida, /pagamento conferir (REV-first mantendo nome+\[MEIO\]), digest com total no topo (mantendo Feriado), /prioridade sem pipes.
- Refeição sem migração de teclado: ack separado da convocação (2 entradas no array — trivial) + chamado reescrito **mantendo** a linha de horários livres + dedupe com ack + fora-da-vez com posição na fila.

**Onda 3 — Estrutural** *(esforço: G; envolve infra nova e 1 decisão de negócio)*
- Migração completa do fluxo de refeição para inline keyboard: callback_data por modo+data+ramal+slot, log de auditoria em `telegramIngestedMessages`, undo com autor no snapshot, `editMessageText` limpando teclados mortos, CONFIRM/UNDO migrados, fallback textual na transição, confirmação da divisão restrita à chefia **com fallback de liberação**.
- Nudge escalonado com pulo de vez (decisão com a operação) + wrapper `deleteMessage` + message_id persistido.
- `/comandos` como índice interativo (editMessageText por seção, role re-resolvida no callback).
- Rótulos de botão com contagem de vagas (depende da migração).
- Follow-up de investigação: o que são os números de 6 dígitos no grupo (antes de qualquer copy).

**Critérios de sucesso mensuráveis (reavaliar em 30 dias):** `arrival_missing_name_or_shift` 138→<20 · `no_operational_match` 227→<100 · `pending_expired` 69→<15 · erros de botão de refeição 79→<10 · "message is too long" 6-8→0 · chars/mês de coverage_snapshot reduzidos ~70%.
