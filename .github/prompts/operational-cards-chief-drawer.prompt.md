---
description: "Use quando for criar cards operacionais, linhas de base ou PA, drawer lateral de chefia, ações rápidas de correção, encerramento ou mudança de função"
name: "Cards Operacionais e Drawer de Chefia"
argument-hint: "Descreva o card, lista operacional ou drawer lateral que precisa ser projetado"
agent: "agent"
model: "GPT-5 (copilot)"
---

Projete a tarefa solicitada como componente operacional de missão crítica para SAMU.

O resultado precisa seguir estas regras:

- card operacional, não linha de tabela administrativa
- leitura em 2 segundos do código da base ou PA, nome, horário e status
- borda lateral com cor semântica por estado
- densidade alta e controlada
- tipografia forte para código e horário
- ações do chefe rápidas, discretas e sem peso visual excessivo
- status, chips e badges com função real
- nada de visual SaaS pastel ou card fofo genérico

Se a tarefa envolver drawer lateral de chefia:

- abrir como painel lateral elegante e compacto
- mostrar contexto operacional no topo
- formulário mínimo
- edição de horário, função, nome e encerramento sem ruído visual
- atualização instantânea da UI após salvar
- priorizar confirmação clara, não excesso de modais

Se a tarefa envolver lista de cards:

- manter código da base ou PA como âncora visual principal
- nome do médico como segundo nível
- horário em destaque cromático
- badge de status pequeno e preciso
- hover funcional e animação mínima

Evite:

- colunas demais
- tabela tradicional
- excesso de filtros
- sombras decorativas exageradas
- botões muito grandes

Entregue algo com atmosfera de comando operacional.

Tarefa solicitada: ${input}