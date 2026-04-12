# Auditoria Inteligente do Telegram Bot — Abril 2026

**Base de dados:** 1.629 mensagens de 25/mar a 05/abr/2026
**Distribuição:** 1073 accepted (66%) · 427 ignored (26%) · 108 error (7%) · 12 superseded · 6 pending_justification · 3 pending_name_selection

---

## 1. RESUMO EXECUTIVO

### Principais padrões encontrados

1. **Base desativada é a causa #1 de erro em massa** (20 de 108 erros). Quando PM40 foi desativada em 30/mar, gerou 12 tentativas frustradas consecutivas — cada médico e chefia tentando de formas diferentes. O bot repete "Reative a USA antes" sem oferecer ação ao operador autorizado.

2. **"Saída sem ocupação ativa" é a causa #2** (15 erros). Ocorre por: ocupação já fechada por virada de turno, bot anterior já encerrou, ou médico mudou de base sem registro. Resposta não ajuda a investigar — não diz QUANDO a última ocupação existiu.

3. **Name resolution com candidato único pede confirmação desnecessária** (~40% dos pending_name_selection). Nomes como "Larissa Moreia" (typo de Moreira), "guilherme rableo" (typo de Rabelo), "Franceso" (typo de Francesco) têm **um único candidato** mas caem em pending porque o score fica < 150.

4. **extractNames contamina a query com lixo operacional** — exemplos reais: `"Taiara mudando PA"`, `"Lucio fui"`, `"Décia após redigir ocorrências"`, `"Luana porque fui pela"`, `"LOGADA"`, `"Relato plantão"`. Tokens como "mudando", "fui", "pela", "após", "redigir", "ocorrências", "logada" não estão em NAME_NOISE_TOKENS.

5. **Mensagens multi-linha não-operacionais** (relatórios do bot, notícias do grupo) são parseadas forçadamente — ex: relatório de 📋 com ✅/🟡/🔴 foi tratado como arrival em CB02.

6. **Erros de DB (Failed query on insert)** bloqueiam médicos: 3 inserts falharam por violação de constraint durante race condition, e o retry posterior com "1" (resposta de seleção) persistiu corretamente — mas o erro original ficou sem explicação para o usuário.

7. **Justificativa de departure** usa vocabulário restrito (apenas "ocorrência"/"higienização"), mas médicos respondem "Passagem de plantão", "Rendido por Vinícius" — ambas rejeitadas. A mensagem de erro não explica quais termos são aceitos.

8. **Respostas do bot nunca confirmam turno (SD/SN/P)** explicitamente na resposta padrão de arrival/departure. Quando o turno é inferido errado, o operador não percebe no feedback.

### Métricas de impacto

| Métrica | Valor | Impacto |
|---------|-------|---------|
| Erros que geraram retry humano | ~45 de 108 (42%) | Alto — retrabalho da chefia |
| Pending name com candidato único | ~10 de 13 (77%) | Médio — fricção desnecessária |
| Mensagens ignoradas com ação reconhecida | 119 de 427 (28%) | Variado — maioria correta (casual/meal) |
| Correções manuais `/corrigir` | 46 total, 19 com erro | Alto — 41% das correções falham |
| Saídas bloqueadas por justificativa | 11 de 143 departures (8%) | Médio — atraso na saída |

---

## 2. MAPA DE INTENÇÕES REAIS

### Distribuição por tipo de mensagem (accepted + error + pending)

| Intenção | Volume | % do total operacional | Ambiguidade |
|----------|--------|----------------------|-------------|
| **Chegada (arrival)** | 586 | 49% | Baixa — formato bem padronizado |
| **Saída (departure)** | 191 | 16% | Média — justificativa e timing |
| **Meal break reply** | 197 | 16% | Baixa — mas 56 invalid |
| **Relatório /plantao** | 40 | 3% | Baixa |
| **Correção /corrigir** | 46 | 4% | Alta — 41% de erro |
| **Meal break command** | 33 | 3% | Baixa |
| **Continuação** | 28 | 2% | Média — wording vs explicit P |
| **Saída com relatório** | 24 | 2% | Baixa |
| **Resumo /plantao geral** | 21 | 2% | Baixa |
| **Remoção /remover** | 25 | 2% | Média — base desativada gera loop |
| **Batch** | 10 | 1% | Alta — superseded frequente |
| **Ramal /ramal** | 15 | 1% | Média — confusão role vs doctor |
| **Outros** | ~15 | 1% | Variado |

### Formatos de chegada mais comuns (por frequência observada)

| Formato | Exemplo real | Frequência |
|---------|-------------|------------|
| `Nome Base HH:MM Turno` | "Caio Oliveira 2153 07:00 SD" | ~35% |
| `Nome Base Turno` | "João Marcos BR05 SD" | ~20% |
| `Nome Base HH:MM` | "Ingrid Bandeira 1367 07:20" | ~15% |
| `Nome Base P` | "Ananda Andrade CZ50 P" | ~10% |
| `Base Nome Turno HH:MM` | "sm01 19:00 victor botelho SN" | ~5% |
| `Nome continuando Base` | "kemylla continuando 1362" | ~5% |
| `Nome PA Base HH:MM` | "Felipe Carvalho no PA 2031 as 7:15" | ~5% |
| `Frase livre` | "Bom dia, Taiara SD na 2154" | ~5% |

### Formatos de saída mais comuns

| Formato | Exemplo real |
|---------|-------------|
| `Nome saindo Base` | "Karla Pinto saindo da PR03" |
| `Nome saída Base HH:MM` | "Gustavo Bazin saída da 04 07:00" |
| `Saída Base` | "Saída IT30" |
| `Nome saindo Base HH:MM motivo` | "Luana saindo CN10 18:51 porque fui liberada pela chefia" |

---

## 3. TAXONOMIA DE ERROS

### Erro Classe A — Impacto financeiro/operacional direto

| ID | Erro | Ocorrências | Evidência | Gravidade |
|----|------|-------------|-----------|-----------|
| A1 | **Base desativada bloqueia sem ação** | 20 | PM40 30/mar: 12 tentativas. Bot repete "Reative a USA" sem oferecer `/ativar` | 🔴 Crítico |
| A2 | **Saída sem ocupação ativa** | 15 | "Sara Carneiro saindo PR03" — occ já fechada. "Samara Viana saindo CC70" — idem | 🔴 Crítico |
| A3 | **Board start antes da chegada** (/corrigir) | 7 | "/corrigir PM40 Maria Décia 19:01 SN", "/corrigir Luiz Eduardo continuando 2031 19:00 CP" — bot rejeita sem explicar que a ocupação original é de outro horário | 🔴 Crítico |
| A4 | **Actual end antes da chegada** (departure) | 7 | "Leonardo Cabanelas 2152 saindo 19:05/19:14/19:07" — 4 tentativas seguidas. Ocupação provavelmente com startedAt errado  | 🔴 Crítico |
| A5 | **Insert falha por constraint violation** | 5 | "Ana Bonfim 2032 07:04 SD" etc. — race condition ou continuityGroup conflict | 🟡 Alto |

### Erro Classe B — Retrabalho humano

| ID | Erro | Ocorrências | Evidência | Gravidade |
|----|------|-------------|-----------|-----------|
| B1 | **Name resolution pede seleção com candidato único** | ~10 | "Larissa Moreia", "guilherme rableo", "Franceso", "Edberig PA" | 🟡 Alto |
| B2 | **extractNames contamina query** | ~15 | Queries: "mudando PA", "Lucio fui", "LOGADA", "plantão", "turno" | 🟡 Alto |
| B3 | **Justificativa rejeitada sem explicar termos aceitos** | 4 | "Passagem de plantão" → rejected; "Rendido por Vinícius" → rejected | 🟡 Alto |
| B4 | **command_target_not_found** sem contexto | 10 | "/corrigir 2033 Reinaldo 07:11 SD" — alvo existe mas sem occ ativa → mensagem vaga | 🟡 Alto |
| B5 | **command_forbidden sem rota** | 6 | "/corrigir Syone Feitosa SN BR60" → "restrito a chefia" sem dizer quem pode | ⬜ Médio |
| B6 | **Doctor not resolved com mensagem multi-linha** | 5 | "Willy octavio Rivera arevalo\nNa BR 60 turno SD" → query vira "turno" (2ª parte) | 🟡 Alto |

### Erro Classe C — Confusão silenciosa

| ID | Erro | Ocorrências | Evidência | Gravidade |
|----|------|-------------|-----------|-----------|
| C1 | **Relatório do bot parseado como operacional** | 2+ | "📋 Relato do plantão SN..." tratado como arrival em CB02 | ⬜ Médio |
| C2 | **"Rendido por X" extrai X como médico que chega, não quem sai** | 2 | "Rendido as 6h45 por Mateus na IT30" → registra Mateus como arrival (correto), mas confunde se o remetente que saiu | ⬜ Médio |
| C3 | **Mensagem "BR05 desativada" tratada como arrival** | 1 | Parser vê base code e tenta registrar | ⬜ Médio |
| C4 | **"/ramal 2153 PSIQ" trata PSIQ como nome de médico** | 2 | Bot procura "PSIQ" como nome → "não encontrei" | ⬜ Médio |
| C5 | **Turno não confirmado na resposta** | 100% | Nenhuma resposta de arrival/departure inclui turno | ⬜ Médio (risco silencioso) |

### Erro Classe D — Resposta ruim apesar de processamento correto

| ID | Erro | Ocorrências | Evidência | Gravidade |
|----|------|-------------|-----------|-----------|
| D1 | **arrival_recorded não confirma turno** | 533 | Todas as chegadas | ⬜ Médio |
| D2 | **candidate_prompt não mostra dados entendidos** | ~13 | Operador não sabe que base/hora foi detectada | ⬜ Médio |
| D3 | **departure_not_found não mostra última ocupação** | 15 | "Não achei ocupação ativa" sem "última occ foi X às Y" | ⬜ Médio |
| D4 | **Base desativada repete sem ação útil** | 20 | Repete "Reative a USA" 12x para PM40 | ⬜ Médio |

---

## 4. ANÁLISE DO PARSER ATUAL

### Onde acerta (heurísticas boas)

1. **Detecção de base com código formal** (`SM01`, `PR03`, etc.) — 100% de acurácia observada
2. **ABBREVIATION_MAP** (`"01"→SM01`, `"10"→CN10`) — funciona bem para abreviações numéricas comuns
3. **Vocabulário de departure** bem calibrado — `saindo|saiu|saída|liberado|encerrei|fim de plantão` captura a grande maioria
4. **Vocabulário de continuation** abrangente — `continuo|continuando|fico|emendo|prossigo` + detecção de `P` explícito
5. **Multi-message (parseMessageMulti)** com enriquecimento de contexto vizinho — quando a primeira linha tem nome e a segunda tem base, a correlação funciona
6. **Filtro casual** (isCasualTelegramMessage) evita processar saudações/agradecimentos
7. **DESLOCANDO PARA / INDO PARA** corretamente excluídos do departure signal

### Onde falha (heurísticas frágeis)

1. **extractNames passa lixo operacional para o name resolution**
   - Tokens faltantes em NAME_NOISE_TOKENS: `MUDANDO`, `LOGADA`, `LOGADO`, `APÓS`, `REDIGIR`, `OCORRÊNCIAS`, `FUI`, `PELA`, `PORQUE`, `RELATO`, `PLANTÃO`, `RENDIDO`, `RENDIDA`, `CHEGADA`, `TURNO`, `DESATIVADA`, `DESATIVADO`, `RECONHECEU`, `FURO`, `ESCALA`, `TEMPO`
   - **Impacto**: query contaminada → name resolution não encontra → pending_name_selection (desnecessário) ou doctor_not_resolved

2. **Mensagens multi-linha com contexto diferente em cada linha**
   - "Willy octavio Rivera arevalo\nNa BR 60 turno SD" → o parser pega "Na BR 60 turno SD" como entidade separada, extrai "turno" como nome
   - Solução: `parseMessageMulti` deveria fazer merge antes de split quando a 2ª linha não tem base code

3. **Parênteses em nomes reais**
   - "Victor (Psiq) SD 2153 07:33" → o parser limpa parênteses mas `Psiq` vira noise token → nome final = "Victor" (sem sobrenome)
   - Porém "Psiq" deveria ser detectado como roleFunction e atribuído, mas o regex de role é case-sensitive `PSIQ`, e o texto está capitalized como "Psiq"

4. **COI/CRU sem ramal é dead-end no parser**
   - "BOM DIA LOGADA NO COI 1367 8:03" → `COI` removido como noise, `1367` detectado como ramal → funciona acidentalmente
   - "Ananda CRU SD 07:00" → `CRU` removido, sem ramal → `no_operational_match`

5. **"P/" como role prefix**
   - O parser remove `P/` do texto, mas em "P/COI 1367" seria mais útil extrair como role

### Onde é arriscado (decisões implícitas perigosas)

1. **Primeiro horário encontrado vence** — em "saindo 19:05, chegou 07:00", o `19:05` será o arrivalTime; se fosse uma mensagem de "corrigiu chegada de 07:00, saída 19:05", inverteria
2. **Número nu pode colidir** — "dia 04" casaria com PM04, "bloco 70" com CC70. Baixa probabilidade no contexto real, mas possível
3. **Role detection case-sensitive** — `PSIQ` vs `Psiq` vs `psiq`. O text é uppercased antes do parse, mas se a uppercasing falhar (unicode edge case com `ı` turco etc.), perde

### O que deve mudar na arquitetura

O parser atual é um monólito sequencial: normaliza → regex de base → regex de ramal → regex de turno → regex de horário → regex de sinais → extractNames. Não há separação clara de responsabilidades.

**Proposta de camadas** (sem reescrever tudo):

```
1. NORMALIZAÇÃO: uppercase, substituição unicode, remoção @, pontuação → texto limpo
2. EXTRAÇÃO DE ENTIDADES: base, ramal, turno, horário, role, sinais (arrival/departure/continuation)
3. EXTRAÇÃO DE NOME (isolada): remove entidades já extraídas → tokens → noise filter → nome
4. CLASSIFICAÇÃO DE INTENÇÃO: arrival | departure | continuation | correction | query | casual
5. CONFIDENCE ASSESSMENT: quantas entidades foram extraídas, se há conflito, grau de certeza
6. RESOLUÇÃO DE CONTEXTO (pós-parser, no service): estado anterior, ocupação ativa, turno corrente
```

Hoje as camadas 1-5 estão misturadas em `parseMessage()`. Separar permitiria:
- Expandir NAME_NOISE_TOKENS sem afetar role detection
- Testar cada camada isoladamente
- Adicionar novos sinais sem risco de interferência cruzada

---

## 5. ANÁLISE DAS RESPOSTAS DO BOT

### O que está bom

1. **Delay hint** (`⏱ Registrado às X — Ymin após início do turno`) — excelente feedback, informa o operador que houve atraso e sugere continuação
2. **Variação de templates** (8-30 variantes) — evita monotonia sem perder clareza
3. **Justificativa com exemplos** — "ocorrência" e "higienização" são citados no prompt
4. **Departure correction prompt** — mostra dados do registro antes de pedir horário
5. **Batch review** — preview completo antes de confirmar, com issues listadas

### O que está ruim

| Problema | Evidência | Impacto |
|----------|-----------|---------|
| **Turno NUNCA confirmado** | arrival_recorded: "ficou em 2153 desde 07:00" — não diz SD | Se turno inferido errado, operador não percebe |
| **candidate_prompt não confirma dados** | "Falta só fechar o nome" — não diz "entendi base 2151, 19:16, SN" | Operador não sabe o que foi detectado |
| **departure_not_found sem contexto** | "Não achei ocupação ativa de Samara em CC70" — não diz "última occ: X às Y" | Operador não sabe se é erro dele ou do sistema |
| **Base desativada sem ação** | Repete "Reative a USA" sem oferecer `/ativar PM40` | Chefia tenta várias formas sem saber o comando |
| **Justificativa rejeitada sem vocabulário** | "Passagem de plantão" → rejeitado → nenhuma dica dos termos aceitos | Operador tenta frases genéricas em loop |
| **no_operational_match quando há dados parciais** | "2033 18:00" → ignored (sem nome) → bot mostra exemplos genéricos; deveria dizer "entendi ramal 2033, 18:00, mas faltou o nome" | Operador não entende o que faltou |

### Templates propostos

**arrival_recorded** (com turno):
```
✅ {name} em {target} | {shift} | chegada {time}
```

**arrival_p_recorded** (com contexto de cobertura dupla):
```
🔵🔁 {name} continua em {target} | P | desde {time}
Cobertura estendida ao próximo turno.
```

**candidate_prompt** (com dados detectados):
```
⚠️ Entendi: {target} | {shift} | {time}
Mas preciso confirmar o nome.

1. {candidato1}
2. {candidato2}

Responda 1 ou 2, ou redigite nome e sobrenome.
```

**departure_not_found** (com contexto):
```
⛔ Não achei ocupação ativa de {name} em {target}.
{lastOccContext}
Se foi encerrada por virada de turno, use /corrigir.
```

**Base desativada** (com instrução):
```
⛔ {target} está desativada desde {time}.
Para reativar: /ativar {target}
Ou peça à chefia para reativar pelo painel.
```

**Justificativa rejeitada** (com vocabulário):
```
⚠️ Não reconheci o motivo para saída tardia.
Motivos aceitos: "ocorrência" ou "higienização".
Exemplo: "Saindo por ocorrência" ou "Higienização da viatura".
```

**no_operational_match COM dados parciais**:
```
⚠️ Entendi {target} {time}, mas faltou {missing}.
Formato: Nome Base HH:MM Turno
Exemplo: {example}
```

---

## 6. PLANO DE MELHORIA PRIORIZADO

### P0 — Erro crítico / risco financeiro-operacional

#### P0.1 — Expandir NAME_NOISE_TOKENS
- **Problema**: extractNames deixa "mudando", "fui", "logada", "pela", "rendido", "plantão", "após", "turno", "desativada", "escala", "furo", "tempo", "chegada" na query → doctor_not_resolved ou pending com candidato único
- **Evidência**: "Taiara mudando PA" → query "Taiara mudando PA"; "Lucio fui" → query "Lucio fui"; "LOGADA" → query "LOGADA"
- **Causa**: NAME_NOISE_TOKENS não acompanhou evolução da linguagem natural dos operadores
- **Mudança**: Adicionar ~25 tokens faltantes a NAME_NOISE_TOKENS
- **Dificuldade**: Baixa — 1 linha no parser.ts
- **Impacto**: Alto — eliminaria ~60% dos pending_name_selection desnecessários

#### P0.2 — Baixar threshold de name resolution para candidato único
- **Problema**: "guilherme rableo" (score ~140) com candidato único "Guilherme Rabelo" requer confirmação; "Franceso" com candidato "Francesco" requer confirmação
- **Evidência**: 77% dos pending_name_selection tinham candidato único
- **Causa**: threshold de 150 é alto para candidato único com match parcial
- **Mudança**: Quando há 1 candidato com score ≥ 100, auto-accept com hint de "nome aproximado"
- **Dificuldade**: Baixa — alterar `pickConfidentDoctorCandidate`
- **Impacto**: Alto — elimina ~10 pending/semana

#### P0.3 — Confirmar turno (SD/SN/P) nas respostas de arrival e departure
- **Problema**: Operador não percebe quando o turno é inferido errado
- **Evidência**: Nenhuma das 533 confirmações de arrival inclui turno
- **Causa**: Templates de `arrival_recorded` e `departure_recorded` não incluem `{shift}`
- **Mudança**: Adicionar turno aos templates de resposta
- **Dificuldade**: Baixa — alterar templates em replies.ts
- **Impacto**: Alto — previne erros silenciosos de turno

### P1 — Reduz muito retrabalho e ambiguidade

#### P1.1 — candidate_prompt com contexto detectado
- **Problema**: "Falta só fechar o nome" não mostra base, hora, turno detectados
- **Evidência**: Todos os 13 pending_name_selection sem contexto
- **Causa**: template base não inclui placeholders para dados detectados
- **Mudança**: buildCandidatePromptReply recebe parsed data e exibe
- **Dificuldade**: Média — alterar buildCandidatePromptReply + caller
- **Impacto**: Médio — reduz incerteza do operador

#### P1.2 — departure_not_found com contexto da última ocupação
- **Problema**: "Não achei ocupação ativa" sem contexto → operador não sabe se o problema é dele
- **Evidência**: 15 erros "No active occupancy"
- **Causa**: resposta não consulta ocupação recente no domínio
- **Mudança**: Ao falhar departure, buscar última occupancy (últimas 24h) e incluir na resposta
- **Dificuldade**: Média — requer query adicional no fluxo de departure
- **Impacto**: Médio — reduz retentativas cegas

#### P1.3 — Vocabulary hint na rejeição de justificativa
- **Problema**: "Passagem de plantão" e "Rendido por X" rejeitados → operador não sabe os termos
- **Evidência**: 4 rejeições + 2 retry_invalid
- **Causa**: prompt de justificativa não lista vocabulário explícito
- **Mudança**: Incluir "ocorrência ou higienização" como exemplos na mensagem de retry
- **Dificuldade**: Baixa — alterar template
- **Impacto**: Médio — elimina loop de retry

#### P1.4 — no_operational_match com feedback parcial
- **Problema**: "2033 18:00" → "não entendi ação operacional" genérico, quando base e hora foram detectados
- **Evidência**: ~14 ignored arrivals com dados parciais (base detectada, nome ausente)
- **Causa**: quando doctor_not_resolved, reply é genérica demais
- **Mudança**: Se base/hora/turno foi detectado, mencionar na resposta o que faltou
- **Dificuldade**: Média — requer propagar parsed data para reply contextual
- **Impacto**: Médio — operador entende o que faltou e reformula

#### P1.5 — Base desativada com instrução de /ativar
- **Problema**: "Reative a USA antes" repetido 12x para PM40 sem dizer como
- **Evidência**: PM40 30/mar — 12 tentativas
- **Causa**: mensagem de erro não inclui o comando /ativar
- **Mudança**: Incluir "/ativar {base}" na resposta de base desativada
- **Dificuldade**: Baixa — alterar template de erro
- **Impacto**: Médio — elimina loop de frustração

### P2 — Refinamento de UX e clareza

#### P2.1 — Role detection case-insensitive
- **Problema**: "Psiq" não é detectado como PSIQ; "(Psiq)" vira lixo no nome
- **Evidência**: "Victor (Psiq) SD 2153 07:33" → roleFunction: null
- **Causa**: verificação de role codes é case-sensitive no contexto de parênteses
- **Mudança**: Normalizar para uppercase antes de comparar
- **Dificuldade**: Baixa
- **Impacto**: Baixo (poucos casos)

#### P2.2 — /ramal com role como argumento separado
- **Problema**: "/ramal 2153 PSIQ" trata PSIQ como nome de médico
- **Evidência**: 2 ocorrências
- **Causa**: parser de /ramal não separa role de doctor query
- **Mudança**: Detectar role codes como 2º argumento em /ramal
- **Dificuldade**: Baixa
- **Impacto**: Baixo

#### P2.3 — Detectar mensagens do próprio bot e ignorar
- **Problema**: "📋 Relato do plantão SN..." parseado como arrival
- **Evidência**: 2+ casos
- **Causa**: bot_id não é filtrado (ou relatório formatado é colado por operador)
- **Mudança**: Se mensagem começa com 📋 ou contém "Relato do plantão" → ignorar
- **Dificuldade**: Baixa
- **Impacto**: Baixo

#### P2.4 — "RENDIDO POR" como possível keyword de justificativa
- **Problema**: "Rendido por Vinícius" deveria ser aceito como justificativa válida
- **Evidência**: 2+ ocorrências
- **Causa**: "rendido" não está no vocabulário de keywords de departure justification
- **Mudança**: Adicionar "rendido", "rendição", "passagem de plantao" como keywords → auto-accept como tipo "handoff"
- **Dificuldade**: Média — requer novo tipo de justificativa ou bypass
- **Impacto**: Baixo-médio

---

## 7. CONJUNTO DE REGRESSÃO

Os casos abaixo devem ser transformados em testes automatizados.

### Parser — extração de entidades

| # | Input | Entidades esperadas | Decisão esperada |
|---|-------|-------------------|-----------------|
| R1 | `"Caio Oliveira 2153 07:00 SD"` | sector=REGULATION, base=2153, time=07:00, shift=SD, name=CAIO OLIVEIRA | HIGH confidence, arrival |
| R2 | `"kemylla continuando 1362"` | sector=REGULATION, base=1362, name=KEMYLLA, isContinuation=true | Continuation |
| R3 | `"Sara Carneiro P na 02"` | sector=INTERVENTION, base=CB02, shift=P, name=SARA CARNEIRO | P arrival |
| R4 | `"Gustavo Bazin saída da 04 07:00"` | sector=INTERVENTION, base=PM04, time=07:00, isDeparture=true, name=GUSTAVO BAZIN | Departure |
| R5 | `"Taiara mudando de PA para 2151"` | sector=REGULATION, base=2151, name=TAIARA | Arrival (nome limpo, sem "mudando PA") |
| R6 | `"BOM DIA LOGADA NO COI 1367 8:03"` | sector=REGULATION, base=1367, time=08:03, role=COI, name=[] (limpeza total) | Arrival com doctor_not_resolved esperado |
| R7 | `"Saindo da 02 sem rendição (furo na escala)"` | sector=INTERVENTION, base=CB02, isDeparture=true, name=[] | Departure sem nome |
| R8 | `"Victor (Psiq) SD 2153 07:33"` | sector=REGULATION, base=2153, shift=SD, time=07:33, role=PSIQ, name=VICTOR | Arrival |
| R9 | `"Larissa Moreia BR60 P"` | sector=INTERVENTION, base=BR60, shift=P, name=LARISSA MOREIA | P arrival (typo em nome) |
| R10 | `"carolina restrepo villafuerte cru 2033 07:20"` | sector=REGULATION, base=2033, time=07:20, name=CAROLINA RESTREPO VILLAFUERTE | Arrival |
| R11 | `"Rendido as 6h45 por Mateus na IT30"` | sector=INTERVENTION, base=IT30, time=06:45, name=MATEUS | Arrival (quem chegou) |
| R12 | `"1361 Fernando Bandeira SN 19:38"` | sector=REGULATION, base=1361, shift=SN, time=19:38, name=FERNANDO BANDEIRA | Arrival |
| R13 | `"Luana saindo CN10 18:51 porque fui liberada pela chefia"` | sector=INTERVENTION, base=CN10, time=18:51, isDeparture=true, name=LUANA | Departure |
| R14 | `"2033 18:00"` | sector=REGULATION, base=2033, time=18:00, name=[] | No name extracted, no arrival signal |
| R15 | `"BR05 desativada"` | sector=INTERVENTION, base=BR05 | Deveria ser ignorado (intent=info, não arrival) |
| R16 | `"emily thays jardim santos 1363 p cru 07:00"` | sector=REGULATION, base=1363, shift=P, time=07:00, role=CRU, name=EMILY THAYS JARDIM SANTOS | P arrival |
| R17 | `"Vinicius Raimundo saída da IT30 às 6h45 após chegada do colega do SD"` | sector=INTERVENTION, base=IT30, time=06:45, isDeparture=true, name=VINICIUS RAIMUNDO | Departure |
| R18 | `"Passagem de plantão"` | Justificativa: deveria ser aceita ou rejeitada com vocabulário explícito | |
| R19 | `"Rendido por Vinícius Raimundo"` | Justificativa: deveria ser aceita como handoff | |
| R20 | `"@caiooliveirac , o Bot não me reconheceu!!!\n@chefe2031"` | Deveria ser ignorado (menção + reclamação) | |

### Name resolution — extração de nome limpo

| # | Input (extractNames) | Nome esperado | Tokens que NÃO devem aparecer |
|---|---------------------|--------------|------------------------------|
| N1 | `"Taiara mudando de PA para 2151"` | TAIARA | mudando, PA |
| N2 | `"Lucio saindo da PR03 fui rendido agora"` | LUCIO | fui, rendido, agora |
| N3 | `"Luana saindo CN10 18:51 porque fui liberada pela chefia"` | LUANA | porque, fui, liberada, pela, chefia |
| N4 | `"Décia saindo pm40 após redigir ocorrências"` | DÉCIA | após, redigir, ocorrências |
| N5 | `"BOM DIA LOGADA NO COI 1367 8:03"` | [] (empty) | BOM, DIA, LOGADA, COI |
| N6 | `"Victor (Psiq) SD 2153 07:33"` | VICTOR | Psiq |
| N7 | `"Em tempo, saida CZ50 7:15"` | [] | Em, tempo |

---

## Apêndice: Dados brutos de referência

### Top 10 mensagens de erro mais repetidas

| Mensagem | Contagem |
|----------|----------|
| Base desativada. Reative a USA antes de abrir nova cobertura. | 20 |
| No active intervention occupancy found for this doctor/base. | 15 |
| command_target_not_found | 10 |
| Ha inconsistência na lista de medicos ativos. | 7 |
| Board start cannot be before the recorded arrival. | 7 |
| Actual end cannot be before the recorded arrival. | 7 |
| Justificativa obrigatoria (variantes) | 11 |
| Failed query (DB constraint violation) | 5 |
| fetch failed | 3 |
| Telegram API sendMessage: too long / not found | 4 |

### Médicos com mais erros/pending

- Ana Beatriz (3 homônimas no sistema: D'Almeida, Carvalho, Bonfim) — 5+ ambiguidades
- Victor (3 homônimos: Botelho, Silva, Mangabeira) — 3+ pending
- Leonardo Cabanelas — 4 departures bloqueadas por "end before arrival"
- Samara Viana — 2 departures "no active occupancy" (CC70)
