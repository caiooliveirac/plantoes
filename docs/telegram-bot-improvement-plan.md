# Plano de Melhoria do Bot Telegram — SAMU 192

**Data:** 07/04/2026
**Base:** 101 mensagens auditadas hoje + 7 dias de histórico + leitura completa de parser.ts, service.ts, regulation/service.ts, intervention/service.ts, rules.ts

---

## P1 — Pending states sem expiração (CRÍTICO)

### Causa raiz

`findPendingNameSelection` ([service.ts#L4107](../modules/telegram/service.ts#L4107)) e `findPendingDepartureJustification` ([service.ts#L4119](../modules/telegram/service.ts#L4119)) buscam o pending mais recente por `(chatId, senderTelegramId)` sem filtro de `created_at`. A query retorna pending de qualquer idade:

```ts
// service.ts:4107
async function findPendingNameSelection(chatId: string, senderTelegramId: string) {
    return db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_name_selection"),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
}
```

O mesmo padrão se repete em `findPendingDepartureJustification` (L4119) e `findPendingDepartureCorrection` (L4131).

### Impacto operacional (07/04)

| Pending | Desde | Sender | Efeito |
|---------|-------|--------|--------|
| `pending_name_selection` (Thainara, 03/04 → substituído) | 3d atrás | COI 1367 | Capturou "kkkkkkkkk" e "@caiooliveirac ajuda ai..." criando novo pending zumbi |
| `pending_departure_justification` (Tiago Neves, 07:14) | 5h+ | 709298498 | Interceptará próxima msg de Tiago antes de qualquer parsing normal |
| `pending_departure_justification` (Maria Elisa, 07:30) | 5h+ | 329620581 | Idem |

**Dados globais:** 12 pending states ativos agora (9 departure_justification, 3 name_selection), o mais antigo com 4 dias.

### Solução proposta

**TTL:** 30 minutos para todos os pending states.

**Mecanismo:** Lazy expiry no momento do lookup (não precisa de cron):

```
findPendingNameSelection(chatId, senderTelegramId):
  buscar pending mais recente...
  WHERE status = 'pending_name_selection'
  AND created_at >= NOW() - INTERVAL '30 minutes'   ← NOVO

  Se nada retornar, buscar pending expirado para limpar:
    UPDATE status = 'superseded', error_message = 'pending_expired'
    WHERE status = 'pending_name_selection'
    AND senderTelegramId = ...
    AND created_at < NOW() - INTERVAL '30 minutes'
```

**Comportamento ao expirar:**
- Silencioso. Sem notificação ao usuário — o pending simplesmente deixa de interceptar mensagens.
- A próxima mensagem operacional do sender será processada normalmente.
- O pending expirado é marcado como `superseded` com `error_message = 'pending_expired'` para rastreabilidade.

**Outros pending types a cobrir:** `pending_departure_correction` (L4131) — mesmo padrão, mesmo TTL.

### Riscos e efeitos colaterais

- **Risco baixo:** Um médico que demora mais de 30min para responder ao prompt de seleção terá que reenviar a mensagem original. Isso é aceitável — 30min sem resposta indica que o médico se distraiu.
- **Atenção:** O TTL deve ser por `created_at` do pending original, não por `processedAt`.

### Critério de sucesso

- Zero pending states com age > 30 minutos.
- Mensagens conversacionais (como "@caiooliveirac ajuda ai...") de senders com pending antigo passam pelo parsing normal ao invés de serem capturadas pelo pending.

---

## P2 — Ocupações zero-duration por falso positivo em cascata (MODERADO)

### Causa raiz

Quando uma nova ocupação é criada em base já ocupada, o auto-close usa:

```ts
// intervention/service.ts:L310
const takeoverAt = input.startedAt.getTime() >= currentBoardCarrier.startedAt.getTime()
    ? input.startedAt
    : currentBoardCarrier.startedAt;
```

Se `input.startedAt == currentBoardCarrier.startedAt` (chegada retroativa ao mesmo horário), o `endedAt` fica igual ao `startedAt` → duração zero.

No regulation/service.ts (L294), a lógica adiciona `resolveRegulationBoardEndAt` que pode clampar ao `scheduledEndAt`, mas o fallback é `existing.startedAt` — mesmo problema.

### Impacto operacional

**9 ocupações zero-duration nos últimos 7 dias**, todas via Telegram:

| Data | Médico | Base | Causa provável |
|------|--------|------|----------------|
| 01/04 | Vagner Barroso | PR03 | Chegada retroativa |
| 01/04 | Syone Feitosa | BR60 | Chegada retroativa |
| 02/04 | Beatriz Bomfim | PM40 | Chegada retroativa |
| 04/04 | Fred Anderson | BR60 | Chegada retroativa |
| 07/04 | Karen Seifarth | PM40 | Maiana retroativa (06:50) fechou Karen (07:11) |
| 07/04 | Vinicius Raimundo | BR60 | "aaindo" de Tiago (falso positivo) |
| 07/04 | Alexandre Farias | IT30 | "rendido" de Lúcio → arrival falso |
| 07/04 | Ana Luiza Alves | 1367 | Re-postagem de Caio |
| 07/04 | Uenderson Barbosa | 1361 | Edição/re-postagem |

**Custo:** 6 das 15 mensagens de Caio hoje foram correções manuais causadas por ocupações zumbi.

### Solução proposta

**Guard na camada de serviço**: antes de inserir a nova ocupação, verificar se a autoclose resultaria em duração ≤ 0. Se sim, **abortar a criação** ao invés de criar uma ocupação zero.

```
// Pseudocódigo - intervention/service.ts e regulation/service.ts
if (shouldTakeBoardImmediately && currentBoardCarrier) {
    const takeoverAt = max(input.startedAt, currentBoardCarrier.startedAt);
    const resultingDuration = takeoverAt - currentBoardCarrier.startedAt;

    if (resultingDuration <= 0) {
        // Não fechar ocupação existente — a nova chegada é duplicata ou retroativa
        // Apenas fazer update-in-place se for o mesmo médico
        // Se for médico diferente, lançar erro explicativo
        if (currentBoardCarrier.doctorId === input.doctorId) {
            // update-in-place: atualizar campos do existente
            return existing;
        }
        // Médico diferente com startedAt <= existente: conflito irreconciliável
        // Registrar como erro ao invés de criar zero-duration
        throw new Error("arrival_conflicts_with_active_occupancy");
    }

    // Fechar normalmente...
}
```

**Duração mínima:** 1 minuto (60.000ms). Se `takeoverAt - startedAt < 60_000`, tratar como conflito.

### Riscos e efeitos colaterais

- **Risco médio:** Chegadas retroativas legítimas (Caio lançando médico que chegou antes do ativo) serão bloqueadas se o horário retroativo for anterior ao startedAt do ocupante atual. Nesses casos, o supervisor precisará usar `/retirar` primeiro.
- **Mitigação:** O erro `arrival_conflicts_with_active_occupancy` deve ter mensagem clara: "Já há alguém ativo em {base} desde {hora}. Use /retirar {base} antes de registrar nova chegada."
- **Impacto em relatórios:** Ocupações zero-duration existentes permanecerão — considerar script de limpeza para as 9 existentes.

### Critério de sucesso

- Zero ocupações zero-duration criadas por Telegram.
- Supervisor recebe mensagem clara de conflito ao invés de ocupação fantasma silenciosa.

---

## P3 — Falsos positivos de chegada (CRÍTICO)

### Causa raiz

Múltiplos vetores de falso positivo:

**3a. ARRIVAL_SIGNALS ambíguos** ([parser.ts#L32](../modules/telegram/parser.ts#L32)):
- `RENDENDO|RENDI` (L33) — "rendendo" = chegada (correto), mas "fui rendido" = partida (errado). O signal é `\bRENDI\b`, que faz match em "rendido" (embora "rendido" esteja em NAME_NOISE_TOKENS, ele faz match no ARRIVAL_SIGNALS antes do extractNames).
- `CONTINUO|CONTINUA|SEGUINDO|SIGO` (L35) — estes estão duplicados em ARRIVAL_SIGNALS e em CONTINUATION_SIGNALS. A consequência é que são tratados como arrival quando não há continuation context.

**3b. Gate F3 prejudica shorthands legítimos** ([service.ts#L6048](../modules/telegram/service.ts#L6048)):
O gate atual bloqueia `confidence !== "HIGH" && extractedNames.length === 0 && !isDeparture`. Mas o fluxo de resolução de médico via sender name fallback (`resolveOperationalDoctor` → `shouldUseTelegramSenderNameFallback`) acontece DEPOIS de F3, portanto nesse caso F3 bloqueia antes do sender fallback ser tentado.

Mensagens legítimas bloqueadas por F3 (hoje):
- "1367 03:00" (Ana Luiza — ramal + hora, sem nome) → confidence = MEDIUM
- "na 50, p" (Lucas Maia — base + turno, sem nome) → confidence = MEDIUM

**3c. Mensagens com @menção** ([service.ts#L1200](../modules/telegram/service.ts#L1200)):
`shouldUseTelegramSenderNameFallback` retorna `false` se há @mention. Mas a mensagem **ainda é parseada normalmente** — ela só não faz fallback para sender name. Se tiver base/ramal, será processada como operacional. Não há descarte de mensagens com @mention.

**3d. Mensagens numéricas como pending reply** — "1", "2", "3" são respostas legítimas a `pending_name_selection`, mas quando não há pending ativo, `tryHandlePendingNameSelection` retorna `null` e a mensagem cai no parsing normal. Se houver ABBREVIATION_MAP match (ex: "1" → SM01), vira arrival falsa.

### Impacto operacional

- **21 mensagens numéricas** ("1", "2", "3") aceitas como arrival/departure em 7 dias. A maioria são respostas legítimas a pending, mas algumas chegam após o pending já ter sido consumido.
- **"aaindo"** → criou arrival falsa para Tiago + zero-duration de Vinicius.
- **"fui rendido"** → criou arrival falsa para Lúcio + zero-duration de Alexandre.

### Solução proposta

**3a.** Refinar ARRIVAL_SIGNALS — separar "rendendo" (ativo = chegada) de "rendido" (passivo = partida):

```
// Antes:
/\b(?:CHEGUEI|CHEGANDO|CHEGADA|PRESENTE|ASSUMINDO|ASSUMI|RENDENDO|RENDI)\b/i,

// Depois:
/\b(?:CHEGUEI|CHEGANDO|CHEGADA|PRESENTE|ASSUMINDO|ASSUMI|RENDENDO)\b/i,
```

Remover `RENDI` dos ARRIVAL_SIGNALS. Manter `RENDENDO` (gerúndio ativo = "estou rendendo" = estou chegando para render). Adicionar `RENDIDO` aos DEPARTURE_SIGNALS como passivo:

```
// Novo DEPARTURE_SIGNAL:
/\b(?:FUI\s+RENDID[OA]|SENDO\s+RENDID[OA])\b/i,
```

**3b.** Mover F3 para DEPOIS da resolução de sender name — ou melhor, permitir sender fallback dentro do gate:

```
// Pseudocódigo - após F3 detectar MEDIUM + no names + no departure:
// Antes de rejeitar, tentar sender name:
if (shouldUseTelegramSenderNameFallback(message.text)) {
    const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
    const senderResolved = await resolveDoctorWithFallback(senderName);
    if (senderResolved.doctor) {
        // Prosseguir normalmente com sender doctor
        // NÃO rejeitar
    }
}
// Se nem sender resolveu → rejeitar como low_confidence_no_name
```

**3c.** Mensagens contendo @mention no body (não como prefixo de comando) devem ser ignoradas como conversa:

```
// Antes de parseMessageMulti:
if (/@\w+/.test(message.text) && !message.text.startsWith('/')) {
    // Ignorar silenciosamente como conversa
}
```

**3d.** Mensagens numéricas puras ("1", "2", "3") que chegam sem pending ativo devem ser ignoradas silenciosamente:

```
// Após tryHandlePendingNameSelection retornar null:
if (/^\d{1}$/.test(message.text.trim())) {
    // Ignorar silenciosamente - provavelmente resposta a pending já consumido
}
```

### Riscos e efeitos colaterais

- **3a:** Removendo `RENDI` de ARRIVAL_SIGNALS, mensagens como "rendi na PM40" (= vim render = chegada) deixariam de ter arrival signal. Mas `RENDENDO` permanece e cobre o gerúndio. Risco baixo.
- **3b:** Mover F3 abre brecha para sender fallback resolver médico errado em conta compartilhada. Mitigação: combinar com P7 (shared account detection).
- **3c:** Médicos que mencionam @bot junto com registro perderiam a captura. Atualmente nosso bot é mencionado via reply, não via @mention inline, então risco baixo.
- **3d:** Se um médico legitimamente envia "1" ou "2" como número de base curto (ABBREVIATION_MAP), perderia o registro. Mas isso nunca é intencional em grupo — a mensagem ABBREVIATION_MAP é um efeito colateral do parseamento agressivo.

### Critério de sucesso

- Zero arrivals geradas por "rendido" passivo.
- F3 não bloqueia shorthands de médicos com sender name resolvível.
- Mensagens com @mention são ignoradas silenciosamente.

---

## P4 — NAME_NOISE_TOKENS incompleto (BAIXO-MÉDIO)

### Causa raiz

`extractNames` ([parser.ts#L414](../modules/telegram/parser.ts#L414)) filtra tokens contra `NAME_NOISE_TOKENS` (L86). Palavras de jargão não listadas sobrevivem como candidatos a nome.

### Impacto operacional

Query `reviewDoctorQuery` dos últimos 7 dias revelou:

| Token poluente | Exemplo | Efeito |
|---------------|---------|--------|
| `planta` | "Finalizando planta na CRU" | doctorQuery = "planta" → doctor_not_resolved |
| `ALMOÇO/ALOMOÇO` | "MARIANA ALOMOÇO 1368" | doctorQuery = "MARIANA ALOMOÇO" → ambiguidade |
| `Realocado` | "Realocado para BR60" | doctorQuery = "Realocado" → doctor_not_resolved |
| `Remanejado` | standalone use | doctorQuery = "Remanejado" → doctor_not_resolved |
| `ocorrencia` | "Emmanuelle ocorrencia" | poluiu nome → "Emmanuelle ocorrencia" |
| `plantão` | "Nadyja plantão" | poluiu nome → "Nadyja plantão" |
| `eu` | standalone | doctorQuery = "eu" |
| `turno` | standalone | doctor_not_resolved |
| `CB` | standalone | doctor_not_resolved |
| `Corrigir` | "Corrigir Samara Messias..." | poluiu nome |
| `/descanso` | "Claudio teiteixa /descanso" | poluiu nome |
| `Médico/MRV/CHEFE` | sender names | poluiu doctor query |
| `inté` | "Samara Messias inté" | poluiu nome |

### Solução proposta

Adicionar ao `NAME_NOISE_TOKENS`:

```ts
// Jargão operacional
"PLANTA", "PLANTAR",
"REALOCADO", "REALOCADA", "REALOCANDO",
"CORRIGIR", "CORRECAO", "CORREÇÃO",
"MEDICO", "MEDICA", "MÉDICO", "MÉDICA",
"MRV", "CHEFE",
"EU", "MEU", "MINHA",
"INTE", "INTÉ",
"CB",  // abreviação solta sem número
"COMUNICO",
```

**Tokens a NÃO adicionar** (ambíguos com nomes próprios):
- `RAMOS` — pode ser sobrenome (Vanessa Brito Ramos)
- `SILVA` — sobrenome frequente
- `COSTA` — sobrenome (Paula Mayana Costa Santos)

**Nota sobre normalização:** `normalizeTelegramText` já strip acentos (NFD), então basta listar a forma sem acento para tokens acentuados. Ex: "PLANTÃO" já é coberto por "PLANTAO" existente. Mas "MÉDICO" normaliza para "MEDICO" — então basta "MEDICO".

### Riscos e efeitos colaterais

- Risco baixo. Nenhum dos tokens propostos é nome próprio em português.
- `CHEFE` já está em NAME_NOISE_TOKENS (L94).
- `REALOCADO/REALOCADA` não estão em NOISE mas já estão como parte de REASSIGNMENT_SIGNALS — adicioná-los a NOISE para quando aparecem soltos sem padrão "para".

### Critério de sucesso

- reviewDoctorQuery nunca mais contém "planta", "realocado", "eu", "medico" como fragmento solto.
- Francisco Isensee scenario: "Finalizando planta na CRU (PA 2152)" → extractedNames = [] (vazio, não ["planta"]).

---

## P5 — Qualidade das respostas do bot ao usuário (IMPORTANTE)

### Causa raiz

O sistema de respostas em `replies.ts` já tem 20+ variantes por ação, com emojis consistentes. Os pontos fracos não são no template, mas no **contexto e timing**:

1. **Pending sem guidance suficiente:** O prompt `buildCandidatePromptReply` explica "responda 1, 2, ou 3", mas em tela pequena o contexto (base, horário, turno) fica separado dos botões. O médico pode não entender que precisa agir.

2. **Mensagem ignorada sem feedback (no_operational_match):** O bot responde com exemplo genérico — "Não entendi. Tente assim: Ana Luiza 1367 SD 07:00". Mas quando a mensagem era claramente conversacional ("kkkkk", "@caiooliveirac ajuda ai"), a resposta é inadequada.

3. **Falso positivo aceito sem flag:** Quando o bot aceita uma mensagem que é false positive (ex: "MARIANA ALOMOÇO"), o médico recebe confirmação de chegada sem saber que algo errado aconteceu. Não há mecanismo de "tenho pouca certeza" na resposta.

4. **Pending expirado silencioso:** Hoje não existe — com P1 implementado, precisaremos definir comportamento.

### Solução proposta

**5a. Silêncio seletivo para casual em grupo:**
- Mensagens ignoradas como `casual_smalltalk` em grupo: **sem resposta**. Hoje o bot responde com "👋" — remover essa resposta para reduzir ruído.
- Manter resposta de casual somente em chat privado.

**5b. Resposta de pending simplificada:**
```
⚠️ Encontrei 2 médicos parecidos para {base}:
1️⃣ Mariana Maynart
2️⃣ Mariana Bahia
Toque no número ou redigite nome e sobrenome.
```
- Manter na mesma mensagem: número + nome, sem linhas extras.
- Não incluir horário/turno (já foi registrado, não precisa ser repetido no prompt).

**5c. Resposta de expiração de pending (para P1):**
- Sem notificação. Quando o pending expira, nada acontece. A próxima mensagem do sender é processada normalmente.

**5d. Feedback de confiança na confirmação:**
- Para arrivals via sender name fallback (sem nome explícito no texto), adicionar hint:
```
✅ {doctorName} registrado em {base} às {hora}.
ℹ️ Usei seu nome do Telegram. Se não for você, corrija com nome e sobrenome.
```

**5e. Mensagens de erro técnico:** Não devem chegar ao usuário. Erros de banco, timeout, etc. devem ficar apenas no log. Resposta genérica: "Algo deu errado, tente novamente em 1 minuto."

### Riscos e efeitos colaterais

- **5a:** Médicos que enviam saudações esperando confirmação de que o bot está ativo podem se confundir. Risco baixo — a ausência de resposta é padrão em grupo.
- **5d:** O hint "usei seu nome do Telegram" pode confundir contas compartilhadas. Combinar com P7.

### Critério de sucesso

- Casual messages em grupo: zero respostas do bot.
- Pending prompt: legível em tela de celular sem scroll.
- Nenhum erro técnico (stack trace, "unknown_error") chega ao chat.

---

## P6 — Mensagens casuais e conversacionais capturadas indevidamente (MÉDIO)

### Causa raiz

`isCasualTelegramMessage` ([parser.ts#L353](../modules/telegram/parser.ts#L353)) retorna `false` se encontrar **qualquer** operational cue (base regex, ramal, shift type, arrival/departure signals). Mas muitas mensagens conversacionais contêm fragments que fazem falso match:

- `ALMOÇO` → contém `AL` que pode fazer match com ARRIVAL via contexto
- `@caiooliveirac ajuda ai na divisao do almoço, ele ta entendendo que Mariana chegou 12:30` → contém ramal-like "1367" (vindo do sender_name da conta COI 1367, não do texto em si — mas a verificação de operational cue procura `\b(\d{4})\b` no texto que NÃO inclui sender_name)
- Mensagens com stickers, reações (↩️ Desfazer) — estas já são tratadas como `no_operational_match`

O verdadeiro gap é que `isCasualTelegramMessage` verifica o texto cru, mas a detecção de cues operacionais é agressiva demais — `\b(P)\b` faz match em tokens isolados de abreviações comuns.

### Impacto operacional

- A mensagem "@caiooliveirac ajuda ai..." foi capturada pelo pending (P1), não por parsing direto.
- "1368 ALMOÇO 12:30" corretamente detectada (F5 já intercepta via `looksLikeMealBreakMessage`).
- O gap principal é mensagens com @mention que passam pelo pipeline inteiro.

### Solução proposta

**6a. @mention como sinal de conversa:**
```ts
// No início de processTelegramUpdate, antes de parseMessageMulti:
// Mensagens com @mention inline (não command) são conversacionais
if (message.text && /@\w+/.test(message.text) && !message.text.startsWith('/')) {
    // Ignorar silenciosamente se não tiver base/ramal/nome explícitos
    const quickParse = parseMessage(message.text);
    if (quickParse.confidence === "LOW" || (quickParse.extractedNames.length === 0 && !quickParse.isDeparture)) {
        markIgnored("casual_at_mention");
        return;
    }
}
```

**6b. Comprimento mínimo para parsing em grupo:**
- Mensagens com < 3 caracteres que não são resposta a pending: ignorar silenciosamente.
- Isso cobre "1", "2", "3" soltos (P3d) e stickers de texto.

**6c. Forward de mensagens externas:**
- Mensagens que são `forward_from` ou `forward_from_chat`: ignorar silenciosamente (são compartilhamentos, não registros operacionais).

**6d. Expandir CASUAL_PATTERNS:**
```ts
// Novos patterns:
/\bAJUDA\b/i,              // pedido de ajuda ≠ registro operacional
/\bQUEM\s+(?:E|É|ESTA|TÁ)\b/i,  // perguntas
/\bCADASTR/i,              // dúvidas sobre cadastro
/\bCOMO\s+(?:FAZ|FACO|USA)\b/i,  // dúvidas de uso
```

### Riscos e efeitos colaterais

- **6a:** Um médico que escreve "@bot na PM40" seria ignorado. Verificar se existem mensagens legítimas com @mention nos logs. A função `shouldUseTelegramSenderNameFallback` já retorna false para @mentions, então isso é consistente.
- **6b:** Mensagens "P" (turno P sozinho) ou "SN" são já tratadas como LOW confidence → bloqueadas por F3.
- **6d:** "AJUDA" pode aparecer em "Maria de AJUDA" — nome próprio improvável mas possível. Risco mínimo.

### Critério de sucesso

- Mensagens com @mention: zero processadas como operacionais.
- Mensagens < 3 chars sem pending: zero processadas.
- `isCasualTelegramMessage` cobre pedidos de ajuda e perguntas.

---

## P7 — Contas compartilhadas e contexto de sender (MÉDIO)

### Causa raiz

Múltiplos médicos usam o mesmo dispositivo Telegram em bases/ramais rotativos. O `sender_telegram_id` é o do celular da base, não do médico.

### Mapeamento de contas compartilhadas (14 dias)

| Sender | Nome | Médicos distintos | Tipo |
|--------|------|-------------------|------|
| 1438288563 | Caio Oliveira | 98 | Chefia (lança para todos) |
| 178813051 | 2031 CHEFE | 23 | Chefia delegada |
| 266964423 | 2151 Médico MRV | 12 | Conta de ramal |
| 6101513590 | COI 1367 | 11 | Conta de ramal |
| 7384632335 | 2154 MÉDICO | 9 | Conta de ramal |
| 8309782410 | 2153 MÉDICO | 7 | Conta de ramal |
| 255702331 | 2032 MEDICO | 7 | Conta de ramal |
| 7551076207 | MR COI 1368 | 5 | Conta de ramal |
| 6141899708 | 2034 MEDICO | 5 | Conta de ramal |
| 8192970008 | 2033 MÉDICO | 4 | Conta de ramal |
| 124749726 | 2035 MEDICO | 4 | Conta de ramal |

**Padrão:** Contas de ramal têm sender_name contendo o código do ramal + "MÉDICO/CHEFE/MRV/COI".

### Solução proposta

**7a. Detecção de conta compartilhada:**

Heurística simples baseada no sender_name, sem precisar de tabela de configuração:

```ts
function isSharedAccountSender(senderName: string | null): boolean {
    if (!senderName) return false;
    const normalized = senderName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    // Padrão: 4 dígitos + MEDICO/CHEFE/MRV/COI, ou "COI XXXX", "MR COI XXXX"
    return /\b\d{4}\b.*(?:MEDICO|CHEFE|MRV)/i.test(normalized)
        || /\b(?:COI|CRU)\s*\d{4}\b/i.test(normalized)
        || /\bMR\s+COI\b/i.test(normalized);
}
```

**7b. Comportamento para contas compartilhadas:**
1. **Sender name fallback desabilitado:** Para contas compartilhadas, `shouldUseTelegramSenderNameFallback` sempre retorna `false`. O médico DEVE incluir nome no texto.
2. **Pending name selection: TTL encurtado** para 10 minutos (vs. 30min para contas pessoais). Médicos em conta compartilhada trocam frequentemente.
3. **Exigência de nome explícito:** Em vez de aceitar `confidence = MEDIUM` com sender fallback, exigir `extractedNames.length > 0` para aceitar. Se não tiver nome, pedir rephraseamento.

**7c. Exceção para chefia:**
- `Caio Oliveira (1438288563)` e `2031 CHEFE (178813051)` são contas de chefia que lançam para outros médicos. Esses senders **sempre** incluem o nome do médico no texto — o tratamento de shared account não se aplica porque o doctorQuery vem do texto, não do sender name.

### Riscos e efeitos colaterais

- **Risco médio:** Médicos em conta compartilhada que hoje enviam "1367 07:00" (sem nome) e são resolvidos via sender name terão que reenviar com nome. Isso já é o comportamento desejado — sem nome, o bot não sabe qual médico está na base agora.
- **Mitigação:** Mensagem clara: "Essa conta é usada por vários médicos. Por favor, inclua seu nome: _Ana Luiza 1367 07:00 SD_".

### Critério de sucesso

- Zero pending states zumbis em contas compartilhadas (TTL de 10min + detecção).
- Médicos em conta compartilhada recebem resposta clara pedindo nome quando omitido.
- Chefia (Caio, 2031 CHEFE) continua operando normalmente.

---

## Fase 3 — Sequenciamento e Dependências

### Ordem de implementação

| Ordem | Item | Justificativa | Risco de regressão |
|-------|------|---------------|--------------------|
| 1 | **P1** — TTL de pending states | Desbloqueador: pending zumbi amplifica P3, P6, P7. Sem TTL, os outros fixes são parcialmente anulados. | BAIXO |
| 2 | **P4** — NAME_NOISE_TOKENS | Independente, baixo risco, alto impacto na qualidade do doctorQuery. Pode ser feito em paralelo com P1. | BAIXO |
| 3 | **P7** — Contas compartilhadas | Depende de P1 (TTL diferenciado). Desbloqueia a segurança de P3b (sender fallback em conta compartilhada). | MÉDIO |
| 4 | **P3** — Falsos positivos | Depende de P7 (para saber quando é seguro usar sender fallback). Inclui refinamento de ARRIVAL_SIGNALS e F3. | MÉDIO |
| 5 | **P6** — Mensagens casuais | Depende de P3 (para não conflitar com F3). Expande filtros de descarte. | BAIXO |
| 6 | **P2** — Zero-duration guard | Independente mas menos urgente (ocupações zumbi são visíveis e corrigíveis). | MÉDIO |
| 7 | **P5** — Qualidade de respostas | Depende de todos os anteriores (as respostas mudam conforme cada fix). Fazer por último. | BAIXO |

### Dependências

```
P1 ──→ P7 ──→ P3b (sender fallback + shared account)
P1 ──→ P3d (numeric messages + pending)
P4 (independente)
P6 depende de P3 (F3 gate position)
P2 (independente)
P5 depende de P1+P3+P7 (respostas refletem novos fluxos)
```

### Rollout

**Imediato (pode ir para produção hoje):**
- P1 (TTL) — mudança minimal, sem risco de regressão, resolve o problema mais urgente
- P4 (noise tokens) — adição pura, sem risco de regressão

**Próxima sessão (staging/validação):**
- P7 (shared account detection) — precisa validação com dados reais
- P3 (ARRIVAL_SIGNALS + F3) — precisa testes com mensagens históricas

**Sessão posterior:**
- P6 (casual expansion)
- P2 (zero-duration guard)
- P5 (respostas)

---

## Fase 4 — Queries de Validação

### P1 — Pending states

**Antes:**
```sql
-- Quantificar pending states ativos por idade
SELECT
  status,
  count(*) AS total,
  count(*) FILTER (WHERE created_at < NOW() - INTERVAL '30 minutes') AS expired,
  min(extract(EPOCH FROM (NOW() - created_at))/3600)::numeric(6,1) AS youngest_hours,
  max(extract(EPOCH FROM (NOW() - created_at))/3600)::numeric(6,1) AS oldest_hours
FROM operations_v2.telegram_ingested_messages
WHERE status IN ('pending_name_selection', 'pending_departure_justification', 'pending_departure_correction')
GROUP BY status;
```

**Depois:**
```sql
-- Confirmar que não há pending com mais de 30 min
SELECT count(*) AS stale_pendings
FROM operations_v2.telegram_ingested_messages
WHERE status IN ('pending_name_selection', 'pending_departure_justification', 'pending_departure_correction')
  AND created_at < NOW() - INTERVAL '30 minutes';
-- Esperado: 0
```

### P2 — Zero-duration

**Antes:**
```sql
-- Ocupações zero-duration nos últimos 7 dias
SELECT count(*) AS zero_dur_count
FROM (
  SELECT id FROM operations_v2.intervention_occupancies
  WHERE started_at >= NOW() - INTERVAL '7 days'
    AND ended_at IS NOT NULL
    AND extract(EPOCH FROM (ended_at - started_at)) = 0
  UNION ALL
  SELECT id FROM operations_v2.regulation_occupancies
  WHERE started_at >= NOW() - INTERVAL '7 days'
    AND ended_at IS NOT NULL
    AND extract(EPOCH FROM (ended_at - started_at)) = 0
) z;
```

**Depois:**
```sql
-- Mesmo query — resultado deve ser <= 9 (históricas) e 0 novas após deploy
SELECT count(*) AS zero_dur_count
FROM (
  SELECT id FROM operations_v2.intervention_occupancies
  WHERE started_at >= NOW() - INTERVAL '1 day'
    AND ended_at IS NOT NULL
    AND extract(EPOCH FROM (ended_at - started_at)) = 0
  UNION ALL
  SELECT id FROM operations_v2.regulation_occupancies
  WHERE started_at >= NOW() - INTERVAL '1 day'
    AND ended_at IS NOT NULL
    AND extract(EPOCH FROM (ended_at - started_at)) = 0
) z;
-- Esperado: 0
```

### P3 — Falsos positivos

**Antes:**
```sql
-- Arrivals sem nome explícito (sender fallback) nos últimos 7 dias
SELECT count(*) AS nameless_arrivals
FROM operations_v2.telegram_ingested_messages
WHERE created_at >= NOW() - INTERVAL '7 days'
  AND status = 'accepted'
  AND parsed_action IN ('arrival', 'continuation')
  AND length(raw_text) < 15
  AND raw_text ~ '^\d{1,2}$';
-- Esperado antes: ~21; Esperado depois: 0
```

**Depois:**
```sql
-- Mensagens com @mention processadas como operacionais
SELECT count(*) AS at_mention_accepted
FROM operations_v2.telegram_ingested_messages
WHERE created_at >= NOW() - INTERVAL '7 days'
  AND status = 'accepted'
  AND raw_text LIKE '%@%'
  AND parsed_action IN ('arrival', 'departure', 'continuation');
-- Esperado: 0
```

### P4 — Noise tokens

**Antes:**
```sql
-- reviewDoctorQuery com tokens de jargão
SELECT resolution_data->>'reviewDoctorQuery' AS q, count(*)
FROM operations_v2.telegram_ingested_messages
WHERE created_at >= NOW() - INTERVAL '7 days'
  AND resolution_data->>'reviewDoctorQuery' IS NOT NULL
  AND (
    resolution_data->>'reviewDoctorQuery' ~* '\b(planta|realocado|medico|turno|eu|almoco|ajuda|corrigir)\b'
  )
GROUP BY 1
ORDER BY 2 DESC;
```

**Depois:**
```sql
-- Mesmo query — Esperado: 0 linhas
```

### P5 — Qualidade de respostas

```sql
-- Mensagens de casual_smalltalk que receberam resposta do bot
-- (verificar se bot respondeu em grupo após casual detection)
-- Não há como medir diretamente por SQL — precisa de observação manual
-- ou logging de respostas enviadas pelo bot
```

### P6 — Mensagens casuais

```sql
-- Mensagens com @mention que foram processadas (não ignoradas)
SELECT count(*) AS at_mention_processed
FROM operations_v2.telegram_ingested_messages
WHERE created_at >= NOW() - INTERVAL '7 days'
  AND status NOT IN ('ignored')
  AND raw_text ~ '@\w+'
  AND parsed_action NOT IN ('meal_break_command', 'meal_break_reply');
-- Esperado depois: somente commands legítimos (/almoco@bot_name)
```

### P7 — Contas compartilhadas

**Antes:**
```sql
-- Senders compartilhados que geraram pending states
SELECT sender_name, sender_telegram_id, count(*) AS pending_count
FROM operations_v2.telegram_ingested_messages
WHERE created_at >= NOW() - INTERVAL '14 days'
  AND status LIKE 'pending_%'
  AND sender_name ~* '(MEDICO|CHEFE|MRV|COI)'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

**Depois:**
```sql
-- Mesmo query — Esperado: 0 (shared accounts não geram mais pending)
-- Ou verificar TTL encurtado:
SELECT count(*) AS stale_shared_pendings
FROM operations_v2.telegram_ingested_messages
WHERE status IN ('pending_name_selection', 'pending_departure_justification')
  AND created_at < NOW() - INTERVAL '10 minutes'
  AND sender_name ~* '(MEDICO|CHEFE|MRV|COI)';
-- Esperado: 0
```
