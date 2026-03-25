---
description: "Use when designing, refactoring or generating frontend, UI, dashboard, board, cards, drawer, chief controls, operational screen, SAMU mission-critical interface, regulation view or intervention view. Enforce command-room hierarchy, high-density layout, non-generic visual language and mission-first UX."
applyTo: "app/**/*.tsx,components/**/*.tsx,app/**/*.css"
---

# Frontend Operacional SAMU

- Trate qualquer tela principal como mesa operacional, nunca como dashboard SaaS genérico.
- A operação deve dominar a tela: o agora operacional vem antes de filtros, marketing, navegação ou chrome visual.
- Regulação e intervenção precisam ter leitura imediata, com hierarquia cromática e tipográfica clara.
- Priorize densidade controlada: muita informação útil sem parecer planilha ou card vazio demais.
- Use cor com função real:
  - verde para ativo operacional
  - vermelho para crítico, atraso ou risco
  - âmbar para transição
  - cinza para aguardando
  - azul profundo para estrutura, contexto e moldura da operação
- Evite paleta pastel, layout administrativo clássico, header gigante, sidebar pesada e cards arredondados demais.
- Prefira grids rígidos, ritmo tipográfico forte, chips, badges, pilhas compactas e cartões operacionais com borda lateral por estado.
- Horário, base ou PA e nome do profissional devem ser legíveis em segundos, inclusive à distância.
- Ações de chefia devem ser rápidas e discretas: editar, corrigir horário, alterar função, encerrar presença.
- Quando houver interação de edição, prefira drawer lateral leve em vez de tela pesada ou navegação longa.
- A interface deve parecer viva: estados, transições, skeletons e atualizações suaves importam mais que ornamento.
- Em mobile, aceite rolagem, mas preserve prioridade visual, ação rápida e leitura clara do status.
- Visualmente, procure clima de produto operacional moderno, inspirado por Linear, Raycast, Vercel, ATC simplificado e mesas de trading, adaptado ao SAMU.
