# PROMPT — Auditoria Completa do Bot de Plantões SAMU

> **Como usar:** Cole este prompt inteiro no Claude Opus (VS Code com Cline, Claude Code, ou claude.ai com o projeto anexado). Ele vai executar em duas fases: primeiro análise, depois estratégia.

---

## CONTEXTO DO PROJETO

Você é um auditor sênior de UX e lógica de sistemas analisando um bot Telegram para gestão de plantões do SAMU. O bot gerencia:
- Login/identificação de profissionais
- Avisos de chegada e saída de plantão
- Trocas de ramal e base durante o plantão
- Continuação de plantão (profissional que emenda turnos)
- Divisão/escala de almoço com sistema de prioridade de escolha

### PROBLEMAS CONHECIDOS (relatados pelos usuários):
1. **Login não intuitivo** — o profissional não sabe o que digitar, o fluxo via Telegram é confuso
2. **Troca de ramal/base** — quem já avisou chegada pode trocar de ramal ou base depois, e o sistema não lida bem com isso
3. **Ramal sem dono fixo** — ex: ramal 2032 nem sempre tem o MRV; alguém pode definir outro ramal como MRV pro almoço, e isso bagunça a divisão
4. **Mensagens do bot são confusas** — sem formatação, sem exemplos, sem emoji, sem destaque. O usuário não entende o que deve fazer
5. **Divisão de almoço** — não fica claro quem é a vez de opinar/escolher
6. **Mensagens subsequentes** — profissionais que continuam no plantão seguinte ou que mudam de ramal/base mandam novas mensagens e o bot não interpreta corretamente

---

## FASE 1 — ANÁLISE PROFUNDA

Leia TODOS os arquivos do repositório. Para cada arquivo, analise linha por linha. Depois produza um relatório estruturado cobrindo:

### 1.1 Mapeamento de Fluxos
Para CADA fluxo do bot (chegada, saída, troca, login, almoço, etc.), documente:
- **Trigger:** o que o usuário digita/faz para iniciar
- **Parsing:** como o código interpreta a mensagem
- **Lógica:** o que acontece internamente (banco, estado, variáveis)
- **Resposta:** o que o bot responde ao usuário
- **Efeitos colaterais:** como isso afeta outros fluxos (ex: chegada afeta prioridade de almoço)

### 1.2 Análise de Falhas de Interpretação
Simule mentalmente os seguintes cenários e trace o que acontece no código:
- Profissional chega no ramal 2032, depois troca para o 2035
- Profissional avisa que está na USB-01, depois muda para USB-03
- Profissional emenda plantão (não sai, continua no próximo turno)
- Ramal 2032 fica vazio e outro ramal assume função de MRV
- Profissional digita mensagem com formato inesperado (abreviação, erro de digitação, texto livre)
- Dois profissionais avisam chegada no mesmo ramal
- Profissional tenta avisar saída sem ter avisado chegada

Para cada cenário:
- O código trata isso? Onde exatamente (arquivo + linha)?
- Se não trata, o que acontece? Erro silencioso? Dado corrompido? Resposta errada?
- Qual seria o comportamento ideal?

### 1.3 Auditoria das Mensagens do Bot
Liste TODAS as mensagens que o bot envia ao usuário (copie o texto literal do código). Para cada uma, avalie:
- O usuário entende o que fazer a partir dessa mensagem?
- Falta contexto, exemplo, ou formatação?
- Usa linguagem técnica demais ou ambígua?
- Tem quebra de linha, emoji, caixa alta para destaque?

### 1.4 Análise da Lógica de Almoço
Detalhe completamente:
- Como é definida a ordem de prioridade para escolha de horário de almoço?
- Como a troca de ramal/base afeta essa prioridade?
- O nome de quem está na vez de escolher fica destacado na mensagem?
- O que acontece se alguém que já escolheu troca de ramal?
- Tem race condition se dois usuários respondem ao mesmo tempo?

### 1.5 Análise de Logs (se disponíveis)
Se houver logs, arquivos de debug, ou qualquer registro de mensagens recebidas:
- Identifique padrões de mensagens que o bot não conseguiu interpretar
- Identifique correções manuais que foram feitas (indicando que o bot errou)
- Identifique os formatos de mensagem mais comuns que os usuários usam vs. o que o bot espera

### 1.6 Análise de Arquitetura
- Qual é o mecanismo de persistência? (banco de dados, arquivo, memória?)
- O bot usa webhook ou polling?
- Tem tratamento de erro adequado?
- Tem logging suficiente para debug?
- O estado do plantão é consistente entre reinícios do bot?

---

## FASE 2 — ESTRATÉGIA DE MELHORIAS

Após completar a Fase 1, produza um plano de ação organizado por prioridade.

### 2.1 Mensagens Reformuladas
Para CADA mensagem do bot identificada na Fase 1, reescreva usando:
- 📋 Emoji relevantes para contexto visual
- **CAIXA ALTA** para ações importantes
- Quebras de linha para separar informações
- Exemplos inline do que digitar
- Tom direto e amigável

Formato esperado para cada mensagem:
```
MENSAGEM ATUAL:
[texto atual copiado do código]

PROBLEMAS:
[lista dos problemas identificados]

MENSAGEM PROPOSTA:
[nova versão com emoji, formatação, exemplos]
```

### 2.2 Correções de Lógica
Para cada falha identificada na Fase 1, proponha:
- **O que corrigir** (descrição clara)
- **Onde corrigir** (arquivo + trecho de código)
- **Como corrigir** (pseudocódigo ou código real)
- **Impacto** (o que melhora para o usuário)

### 2.3 Novos Fluxos Necessários
Proponha fluxos que não existem mas deveriam existir:
- Confirmação de troca de ramal/base
- Tratamento de "emenda de plantão"
- Fallback para mensagens não reconhecidas (com sugestões ao usuário)
- Comando /ajuda com tutorial interativo
- Comando /status para o profissional ver sua situação atual

### 2.4 Melhorias na Divisão de Almoço
- Proposta de mensagem clara com o nome de quem deve escolher EM DESTAQUE
- Fluxo de re-cálculo quando alguém troca de ramal
- Confirmação antes de registrar escolha
- Visualização do status atual da escala (quem já escolheu, quem falta)

### 2.5 Melhorias de Arquitetura
- Sugestões para logging mais robusto
- Tratamento de estados inconsistentes
- Backup/recuperação de estado
- Monitoramento de erros

---

## FORMATO DE ENTREGA

Entregue o relatório completo em Markdown com:
1. **Sumário executivo** (5-10 linhas com os achados mais críticos)
2. **Fase 1 completa** (todas as seções 1.1 a 1.6)
3. **Fase 2 completa** (todas as seções 2.1 a 2.5)
4. **Anexo: Tabela de todas as mensagens** (atual vs. proposta, lado a lado)

Seja exaustivo. Não pule nenhum arquivo. Não assuma — leia o código. Se algo estiver ambíguo no código, sinalize como "⚠️ AMBIGUIDADE" e explique os cenários possíveis.
