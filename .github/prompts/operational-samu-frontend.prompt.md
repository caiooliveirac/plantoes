---
description: "Use quando for desenhar, refatorar ou gerar frontend operacional SAMU com hierarquia de missão, alta densidade e identidade visual não-genérica"
name: "Frontend Operacional SAMU"
argument-hint: "Descreva a tela, fluxo ou componente operacional que precisa ser desenhado"
agent: "agent"
model: "GPT-5 (copilot)"
---

Quero que você projete o frontend como uma MESA OPERACIONAL REAL e não como um dashboard SaaS genérico.

A aplicação é usada em ambiente de pressão, tempo real e tomada de decisão clínica e operacional.

O design precisa transmitir:

- urgência controlada
- clareza hierárquica
- leitura instantânea
- foco no que está acontecendo AGORA
- sensação de comando e operação viva

Não quero estética corporativa pastel.
Não quero dashboard administrativo comum.
Quero uma interface operacional moderna, com identidade própria, digna de produtos como:

- Figma Make prototypes
- v0 high-fidelity layouts
- Linear
- Raycast
- Vercel dashboard feel
- sistemas de missão crítica

Princípios visuais:

1. Hierarquia extremamente clara

O olho deve entender em 2 segundos:

- quem está na rua
- quem está na regulação
- onde há vazio
- onde há atraso
- onde há problema

A informação operacional deve dominar a tela.

2. Densidade controlada

A tela deve caber muita informação sem parecer poluída.
Use:

- grids rígidos
- espaçamento matemático
- tipografia forte
- agrupamento visual por função

3. Tensão visual operacional

Use cor com significado real:

- verde para ativo operacional
- vermelho para atraso ou crítico
- âmbar para transição
- cinza neutro para aguardando
- azul profundo para estrutura e contexto

Nada de cores aleatórias ou decorativas.

4. Contraste alto e legível

Considere:

- luz ruim
- monitores antigos
- pressa

Texto precisa ser:

- legível à distância
- números claros
- horários destacados
- status visíveis

Layout principal:

A home deve ser uma tela dominada pela operação.

Topo minimalista:

- data
- turno
- chefe atual
- indicadores resumidos

Abaixo, um grid principal dividido em duas colunas grandes:

- coluna esquerda: regulação
- coluna direita: intervenção

Ambas devem caber na mesma view sem rolagem em desktop.
Cada coluna deve parecer um painel de controle independente.

Cartões operacionais:

Cada médico deve aparecer como card operacional, não como linha de tabela.

Cada card deve conter:

- número da base ou PA em destaque tipográfico
- nome do médico forte
- função ou tag pequena
- horário de chegada em destaque cromático
- status operacional em badge
- botão de ação discreto e rápido para editar ou encerrar

Cada card deve ter:

- borda lateral colorida indicando estado
- leve elevação
- hover funcional
- micro-animação sutil

Estado vivo da operação:

A tela deve transmitir que o sistema está vivo.

Use:

- pequenos pulsos visuais em horários críticos
- atualização suave de dados
- skeleton loading elegante
- transições rápidas ao entrar ou sair médico
- animação de slot voltando a aguardando

Nada de refresh brusco.

Compactação inteligente:

Não usar tabela clássica cheia de colunas.

Transforme dados em:

- blocos visuais
- chips
- badges
- stacks
- grids compactos

Exemplo de priorização visual:

- PA grande
- nome médio
- status pequeno
- hora com cor

Controles do chefe:

O chefe deve conseguir:

- editar rápido
- encerrar presença
- alterar função
- corrigir horário

Sem abrir telas pesadas.

Interação ideal:

- clique no card abre drawer lateral elegante
- formulário mínimo
- salvar instantâneo
- UI atualiza sem reload

Tipografia:

- fonte moderna geométrica para títulos
- fonte altamente legível para dados

Escala sugerida:

- PA ou base: 20 a 24 px
- nome: 16 a 18 px
- horário: bold com cor
- status: badge enxuto

Atmosfera visual:

A aplicação deve parecer:

- moderna
- confiável
- técnica
- operacional
- rápida

Não deve parecer:

- sistema hospitalar antigo
- ERP
- dashboard administrativo genérico
- planilha web

Modo mobile:

No mobile pode haver rolagem, mas deve manter:

- leitura clara
- cards grandes
- ação rápida
- status visível

Resultado esperado:

Quero uma tela:

- com personalidade
- com ritmo visual
- com prioridade operacional
- com hierarquia cromática
- com sensação de tempo real
- que um médico emergencista reconheça como ferramenta de missão

Evite:

- layout de tabela administrativa tradicional
- cards excessivamente arredondados estilo SaaS
- paleta pastel
- espaçamento exagerado
- excesso de filtros visuais
- sidebar pesada
- header gigante

A operação deve dominar a tela.

Inspire-se em:

- Linear issue board density
- Vercel project overview clarity
- Raycast command palette hierarchy
- sistemas ATC simplificados
- mesas de trading modernas

Mas adaptado para operação SAMU.

Contexto específico deste projeto:

- o frontend deve parecer ferramenta de comando, não painel administrativo
- o estado visual mais importante é o agora operacional
- regulação e intervenção devem conviver na mesma tela com hierarquia imediata
- o chefe precisa corrigir rápido sem quebrar o fluxo

Tarefa solicitada: ${input}