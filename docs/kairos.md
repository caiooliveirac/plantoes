# Kairós no plantões — como uma tela migra

O plantões compartilha o **Sistema de Design Kairós** com o app
`escalas-e-trocas-samu` (base slate clara, barra navy, DM Sans/DM Mono,
tema claro/escuro). A fonte da verdade dos tokens é o escalas
(`app/kairos.css` de lá, espelhado aqui em [app/kairos.css](../app/kairos.css));
o guia completo do sistema vive em
`escalas-e-trocas-samu/docs/handoff-kairos/` (README + INTEGRACAO).

## O que a fundação daqui entrega

| Peça | Onde | O quê |
|---|---|---|
| Tokens (claro + escuro) | `app/kairos.css` (importado por `globals.css`) | Rampa completa; claro no `:root`, escuro sob `[data-tema="escuro"]` |
| Ponte de tokens legados | `app/kairos-ponte.css` | Dentro de `.pagina-kairos`, os nomes do dark glass (`--panel`, `--text`, `--accent-*`…) reapontam para os semânticos Kairós |
| Overrides das telas migradas | `app/kairos-plantoes.css` | Regras legadas com cor LITERAL traduzidas para token + padrões de assinatura (raios 5/7/10/14/16, chips de turno, faixa lateral 5px, semáforo) |
| Fontes | `app/layout.tsx` (next/font) | DM Sans (`--fonte-dm-sans`) e DM Mono (`--fonte-dm-mono`) |
| Tema | script anti-FOUC no layout + `ChaveTema` na barra | `localStorage["kairos:tema"]` → fallback `prefers-color-scheme`; `data-tema` no `<html>` |
| Barra de topo | `components/kairos-topo.tsx` | Navy nos dois temas, eyebrow, título, abas (`ABAS_ADMIN`), chave de tema |

## Telas já migradas

- `/admin/payment-closing` (planilha + modal do médico + popovers)
- `/admin/bank-hours`
- `/banco-de-horas/[medicoId]/[ano]/[mes]` (painel do médico)

## Como migrar a próxima tela

1. Envolver TODO o conteúdo da página em `<div className="pagina-kairos">`
   e renderizar `<KairosTopo titulo="…" abas={ABAS_ADMIN} />` no topo
   (sem `abas` para telas de médico).
2. A ponte cobre o que pinta com token. O que pinta com **cor literal**
   precisa de override em `app/kairos-plantoes.css`, sob o escopo
   `.pagina-kairos`, usando SÓ tokens — nunca cor literal nova (o tema
   escuro deixaria de inverter). Um `[data-tema="escuro"]` numa tela é
   sinal de que uma cor literal escapou.
3. Números vivos: `font-family: var(--fonte-mono)` +
   `font-variant-numeric: tabular-nums` na coluna inteira.
4. Raios do sistema: 5 etiqueta · 7 chip · 10 botão · 14 cartão · 16 modal.
   Faixa lateral de 5px é a assinatura do cartão de status. Confirmação de
   ação destrutiva/financeira: dois toques no próprio botão, não
   `window.confirm`.
5. Voz: PT-BR, vocabulário do serviço, botão é verbo, emoji nativo com
   rótulo em texto.

As telas dark glass não migradas continuam intactas: o `:root` legado segue
no `globals.css` e morre quando a última tela migrar (mesmo plano do
escalas).
