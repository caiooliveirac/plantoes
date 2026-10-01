# Plano — Mesa para o chefe de plantão (2031) e para o plantonista

Rascunho de 01/10/2026, em implementação no mesmo dia (branch
`claude/operational-desk-visual-redesign-df1feb`). Decisões fechadas pelo Caio
em 01/10: corte da virada no **portal** (vale para todos os apps); bônus de
minutos **sem teto**; travas valem desde já (sem sombra); plantonista entra em
ramal/USA ocupado com **duas confirmações** (ciente de que há gente; ciente de
que o ocupante sai do painel — na USA vira dupla, ninguém sai); plantonista
nunca escolhe hora; "atraso desconsiderado pela chefia" é o termo; chip de
atraso vira um "OK" pequeno quando abonado. Acréscimo do mesmo dia: o médico
em turno pode pedir **continuar** (dobra, com ciente/recusa da chefia),
**remanejar-se** e **sair** vendo a prévia do banco (quanto deve se atrasou;
excedente dobrado se pontual). Objetivo: o chefe que
está de fato na 2031 corrige atraso, chegada, saída e remanejo com um ou dois
toques e sem fazer conta; o médico plantonista declara chegada e saída pela
própria tela, sem bot e sem dizer que horas chegou.

Fontes: leitura do código em 01/10/2026 (`app/operational-board-client.tsx`,
`modules/operational/corrections.ts`, `modules/bank-hours/*`,
`modules/acessos/portao.ts`, `services/acessos-portao.service.ts`) e dos docs
`chegada.md`, `retirar.md`, `saidas-a-confirmar.md`, `presenca-mesa.md`,
`kairos.md`.

## 1. O que existe hoje e onde dói

| Hoje | Onde | Por que dói |
|---|---|---|
| Cartão do médico mostra só a hora de chegada; **atraso não aparece** no quadro ao vivo | `operational-board-client.tsx:3166`, `:3340` (`resolveOperationalArrival`) | O chefe tem de subtrair da hora do turno para notar o atraso |
| Corrigir chegada = `datetime-local` + motivo livre de 8+ caracteres | `components/board/InlineTimeEditor.tsx:154`, `:84` | Digitar data e hora inteiras num celular; motivo é obstáculo, não informação |
| "Desconsiderar atraso" **não existe** | — | Só há tolerância fixa de 15 min (`early-departure.ts:47`) e o override do saldo inteiro, só admin, em `/admin/bank-hours` |
| Remanejar = `<select>` plano com ~45 opções (inclui a própria origem) + motivo 8+ + estratégia de conflito em texto longo | `operational-board-client.tsx:5092-5362` | Chefia evita usar |
| Turno anterior edita chegada/saída com o mesmo `datetime-local`; **sem** bônus de minutos | `app/historico/turno-anterior/client.tsx`, `InlineTimeEditor` | Chefe precisa calcular e digitar |
| `TimeScrubber` (slider + ±1/±5 + HH:MM) existe e **ninguém usa** | `components/board/TimeScrubber.tsx` | Peça pronta para reaproveitar |
| Médico logado fora do plantão vê "Mesa fechada fora do plantão" e um link para `/medico` | `app/page.tsx:66-84`, `modules/acessos/portao.ts:37-44` | Beco sem saída: ele não consegue entrar no plantão por ali |
| Médico em turno vê o quadro só leitura; `canManage` só admin/chief | `app/page.tsx:118-123` | Não consegue declarar a própria saída |
| Quem é "o chefe" = quem ocupa a 2031 (`CHIEF_REGULATION_POST_CODE`); o quadro **não liga** a sessão do chief à ocupação dele | `modules/operational/roles.ts:54`; `session.doctorId` só alimenta "Meu painel" e o portão | Qualquer chief logado tem os mesmos poderes, esteja ou não de plantão |
| Chief não altera a própria chegada na 2031: vira pedido ao admin | `modules/operational/chief-arrival-guard.ts:47` | Regra boa; qualquer ação nova sobre a chegada do próprio chefe tem de respeitá-la |

Fatos que travam decisões de desenho (verificados):

- `arrivalDelayMinutes` nasce em `calculator.ts:56-64` de
  `startedAt` da **primeira** ocupação do grupo de continuidade menos
  `scheduledStartAt` (janela inferida pelo posto de chegada). Atraso > 0 também
  derruba a hora extra de dobro para simples e entra no saldo.
- Prioridade de refeição (`meal-breaks.ts:609`, `:1102`), prioridade de saída
  (`departure-priority.ts:238`) e cor do cartão (`resolvePriority`) leem
  `boardStartedAt ?? startedAt`. **Nenhuma lê `arrivalDelayMinutes`.** Logo um
  sinalizador que zere o atraso só no cálculo, sem tocar `startedAt`, não mexe
  em refeição nem em saída. Corrigir a hora de chegada mexe nas três.
- Pagamento lê `bank_hours_entries.arrival_delay_minutes`
  (`payable-shifts.service.ts:338`), então zerar o atraso no `bankHoursEntries`
  basta para pagamento e banco verem o médico como pontual.
- `lateArrivalAcknowledged*` (só intervenção, migration 0019) está
  **aposentado**: nada grava, nada calcula com ele. Não reaproveitar.
- Correções são auditadas (`*_occupancy.corrected`) e desfazíveis por 30 min
  (`modules/operational/undo.ts:48`). Ação nova entra na mesma lista.
- Remanejo pela web grava `started_at = agora` no destino
  (`corrections.ts:1592-1595`); o texto do modal promete "preservando a
  chegada". Hora prevista de chegada segue a do posto onde chegou
  (`posto-de-chegada.ts`), então o banco não muda.
- Portão de turno: `medicoEmTurno` libera a Mesa para quem tem ocupação ativa
  (±30/60 min). Assim que o plantonista abrir uma ocupação pela web, o portão
  abre sozinho.

## 2. Decisões de domínio (antes de qualquer tela)

### 2.1 "Desconsiderar atraso" é um desfecho de chegada, não uma correção de hora

Novo par de colunas nas duas tabelas de ocupação (migration nova, aditiva):

```
arrival_delay_waived_at   timestamptz null
arrival_delay_waived_by   uuid null  -- users.id
arrival_delay_waiver_note text null
```

Regra: se **qualquer** ocupação do grupo de continuidade tem
`arrival_delay_waived_at`, `calculateBankHours` recebe
`arrivalDelayWaived: true` e devolve `arrivalDelayMinutes = 0`, multiplicador
2 e `explanation` começando por "Atraso de N min desconsiderado pela chefia
(motivo)". O N original fica no texto para auditoria.

- `startedAt` e `boardStartedAt` **não mudam** → refeição, saída e cor do
  cartão iguais. É exatamente o pedido.
- Pagamento e banco veem pontual porque leem `bankHoursEntries`.
- Grava evento `*_occupancy.arrival_delay_waived` em `shiftEvents` e entra em
  `undo.ts` (desfazer = limpar as colunas + `sync*BankHours`).
- Reverter depois do turno: mesma rota com `waived: false` (admin ou o próprio
  autor em 30 min via undo).
- Sobre a 2031 do próprio chefe: passa por `shouldBlockChiefArrivalEdit`.
  Chief não desconsidera o próprio atraso; vira pedido ao admin como hoje.
- Madrugada (`docs/madrugada.md`) e PIAM/residente já estão fora do banco;
  nada muda.

Leitores a atualizar quando o valor nascer (mesma lista de `retirar.md`):
`calculator.ts`, `bank-hours/service.ts` (passar o flag do span),
`continuity.ts` (carregar as colunas), `payable-shifts.ts` (tag `ATRASO
ABONADO` opcional no slot), `bank-hours-story.ts` e `doctor-bank-hours-view.ts`
(texto para o médico), `extrator-caso`. Teste-guarda novo
`tests/atraso-desconsiderado.test.ts` (puro + Postgres) e caso em
`tests/payment-duplicate-guard.test.ts` não é afetado.

### 2.2 "Chegou no horário" é correção de hora, com atalho

É o `PATCH …/occupancies/[id]` de hoje com `startedAt = scheduledStartAt` da
janela já inferida. Nenhuma API nova; o servidor já recalcula banco e
reinfere a janela. O que muda é o cliente: o botão preenche a hora. Muda
refeição/saída, e o texto do botão diz isso ("passa a contar como chegada
07:00 para tudo").

### 2.3 "Chefe de plantão" passa a ser um papel calculado

`chefeDePlantao = isAdmin || (session.doctorId ocupa a 2031 agora)`,
calculado no servidor em `app/page.tsx` a partir do snapshot do quadro (a
linha da 2031 já traz `doctorId`). Vai para o cliente como prop.

- Chief logado que **não** está na 2031 enquanto **outro** médico está:
  continua vendo o quadro e os botões, mas toda escrita da Mesa é barrada
  (decisão do Caio, 01/10/2026). Regra no servidor, em `requireMesaSession`
  (ou num `exigirChefeDePlantao` chamado pelas rotas de escrita): responde
  `409 { error: "chefe_de_plantao_outro", chefe: { nome, desde } }`. O
  cliente intercepta esse código em um lugar só (`fetchMesa`) e abre o modal
  de 3.5. Admin isento. 2031 vazia (madrugada, virada) → qualquer chief em
  turno escreve, como hoje.
- `canManage` continua decidindo o que renderiza; a trava é na escrita.
  Chief fora da 2031 não perde o quadro, perde o toque que altera.
- O Telegram não muda: lá o chefe é reconhecido por `TELEGRAM_CHIEF_IDS`.

### 2.3.1 Corte da sessão da Mesa na virada (07:15 e 19:15)

Pedido: tela da Mesa deixada aberta pelo chefe que saiu não pode seguir
operando com a conta dele no plantão seguinte.

- Regra pura em `modules/acessos/presenca.ts`:
  `ultimoCorte(agora)` = o mais recente entre 07:15 e 19:15 de São Paulo
  (`lib/time.ts`). Uma sessão da Mesa **cai** quando `loginAt < virada` (07:00
  ou 19:00 anterior ao corte) **e** `agora ≥ corte`. Quem entrou depois da
  virada (chefe novo às 19:05, plantonista SN às 19:00) não é atingido.
- Onde aplica: na batida `POST /api/mesa/presenca` e em `requireMesaSession`
  (sem batida nenhuma rota entrega dado, então o servidor é a guarda). Estado
  novo `"virada"` ao lado de `ok | ocupada | bloqueada | isento`.
- Tela: igual à `TelaBloqueada`, mas **sem campo de senha**. Texto: "Começou
  um novo plantão. Entre com a conta do chefe atual." Botão único **Entrar**
  → `POST /api/auth/logout` → login único do portal (`lib/auth/portao.ts`).
  Senha não basta porque a conta tem de ser outra.
- Relógio local no `MesaPresenca.tsx` já agenda o bloqueio por ócio; agenda
  também o corte (com aviso 60 s antes, mesmo padrão). Servidor confirma.
- Isentos: admin e operadores da Central na rede da Central (console fica o
  turno todo; mesma isenção de `presenca-mesa.md`). `MESA_PRESENCA` sombra
  continua só registrando.
- Painel de vagas (`tabela`): mesma regra tem de valer lá, mas é **outro
  repo** (`~/Projetos/tabela`, Express + Vite). Fica como tarefa irmã, fora
  deste plano. Quem corta a sessão do portal corta os dois; conferir em
  `mnrs-portal` se a sessão única permite expirar por horário em vez de por
  app. Se permitir, o corte mora no portal e os dois apps só reagem.

### 2.3.2 Nome de quem está logado sempre à vista, com Sair

Hoje a barra da Mesa mostra "Menu ▾"; o e-mail e o "Sair" ficam dentro do
menu (`operational-board-client.tsx:3630`, `:3725`).

- Barra `k-topo`: à direita, fixo, `Fulano · CP 2031` (nome do médico via
  `session.doctorId`; sem médico, o e-mail) e botão **Sair** sempre visível,
  ≥ 44 px, dois toques para confirmar (padrão `kairos.md`). "Menu ▾" fica
  para o resto. No celular o nome encurta para o primeiro nome.
- `tabela`: o header já tem o campo livre "operador" (`OperatorGate.tsx`).
  Trocar por nome vindo da sessão do portal + Sair, e o campo livre só quando
  não houver sessão. Tarefa irmã no repo `tabela`.

### 3.5 Modal "o chefe de plantão agora é Fulano"

Abre em qualquer escrita barrada por `chefe_de_plantao_outro`. Bottom sheet
no celular, diálogo centrado no desktop, uma frase e dois botões:

> **Quem está na 2031 agora é Fulano** (desde 07:05).
> Você está entrando como Beltrano. Esqueceu de entrar com a sua conta?
>
> [ **Entrar com a minha conta** ] [ Continuar só olhando ]

"Entrar com a minha conta" = logout + login único. "Continuar só olhando"
fecha e nada mais acontece. Nunca oferece "assumir": não existe botão de
assumir na Mesa (mesma razão da vez única em `presenca-mesa.md`).

### 2.4 Bônus de minutos no banco

Hoje o override substitui o saldo inteiro e é só admin. Para "dar 30 min de
bônus" sem conta: a tela mostra o saldo automático e botões `+15 +30 +60
−15 −30`, e grava `override = automático + delta` pela rota existente
`POST /api/admin/bank-hours/overrides` (notes = "Bônus de 30 min: <motivo>").
Nenhuma tabela nova.

Permissão: recomendo **abrir ao chefe de plantão com teto de ±60 min por
plantão**, admin sem teto. Rollback de código não desfaz saldo errado, mas o
override é por grupo e tem `notes`; o admin vê tudo em `/admin/bank-hours`.
Se o Caio preferir, fica admin-only na primeira entrega e o botão aparece
desabilitado com "peça ao admin".

### 2.5 Plantonista declara chegada pela web

- Novo `POST /api/medico/chegada` `{domain, targetId}`. Sessão com papel
  `doctor` **e** `doctorId` (portal/tarm/rádio: 403). Hora = `new Date()` no
  servidor, nunca do cliente. Chama `start*Occupancy` com `source: "manual"`
  e `notes: "chegada declarada pela web"`.
  - `manual` existe no enum e só pesa no desempate de duplicata
    (`payable-shifts.ts:672`: telegram +6, manual −10). Aceitável: se o médico
    também mandou "cheguei" no grupo, a mensagem do bot ganha, que é a regra
    "vale a primeira mensagem" de `chegada.md`.
  - Se o médico **já tem** ocupação ativa (`findActiveOccupancyByDoctorId`,
    hoje privada em `telegram/service.ts:1989` → extrair para
    `modules/operational/ocupacao-ativa.ts`), a rota devolve 409 e a tela
    mostra "Você já está na 1362 desde 07:03". Chegada nunca avança nem duplica.
  - Alvo ocupado: primeira entrega **recusa** (409 "ramal ocupado por X, fale
    com o CP"). Tomada de ramal e dupla na USA têm regra própria
    (`chegada.md`, `dupla-usa.md`) e exigem confirmação do chefe; não cabe no
    toque do plantonista. Segunda entrega pode oferecer "entrar como dupla"
    só para base.
  - Ramais eventuais (2266–2270, 4091): fora da grade do plantonista; são
    casos de chefia.
- Novo `POST /api/medico/saida`: usa o mesmo caminho do "saí" do bot
  (`report-departure` na intervenção; na regulação o equivalente de
  `departure-flow.ts`), isto é, **saída declarada, a confirmar pela chefia**
  (`saidas-a-confirmar.md`). O médico não encerra nada sozinho nem escolhe
  desfecho; a hora é a do servidor.
- As duas rotas entram em `tests/route-auth-guard-coverage.test.ts` como
  autenticadas, e o portão de turno continua decidindo o acesso ao quadro:
  depois da chegada, `medicoEmTurno` passa a liberar (invalidar o cache por
  usuário na própria rota).

## 3. Mesa do chefe de plantão — desenho

Tudo dentro de `.pagina-kairos`, só tokens de `app/kairos.css`
(`docs/kairos.md`), sem Tailwind no quadro. Alvos de toque ≥ 44 px.

### 3.1 Atraso visível no cartão

Na coluna de horário, no lugar de só "07:22":

```
07:22  ▲ +22 min        (âmbar até 59 min, vermelho ≥ 60)
07:09                   (≤ 15 min: nada, é tolerância)
07:22  ✓ abonado        (desconsiderado; tooltip com motivo e autor)
08:00  · remanejado     (chegou noutro posto; hora prevista é a de lá)
```

Dado: o `BoardSnapshot` passa a trazer `arrivalDelayMinutes` previsto
(mesma fórmula do calculator sobre `scheduledStartAt` já gravado) e
`arrivalDelayWaived`. Cálculo no `board.service.ts`, não no cliente.

### 3.2 Toque no médico abre a "folha de ações" (bottom sheet no celular,
popover no desktop)

Cabeçalho: nome, posto, "chegou 07:22 · previsto 07:00 · +22 min".

Botões grandes, nesta ordem, com o efeito escrito embaixo em uma linha:

1. **Chegou no horário (07:00)** — "corrige a chegada; muda refeição e
   saída". Só aparece se atraso > 15 min.
2. **Desconsiderar atraso** — "banco e pagamento como pontual; refeição e
   saída seguem 07:22". Pede motivo por chips: `Avisou antes` ·
   `Ficou na ocorrência` · `Erro de registro` · `Outro…` (texto). O chip vira
   `notes` com 8+ caracteres sozinho.
3. **Ajustar chegada…** — abre o editor de horário (3.3).
4. **Remanejar…** — abre o seletor de posto (3.4).
5. **Retirar / Declarar saída** — abre o `DepartureDialog` atual.
6. **Mais** — gaveta profissional de hoje (função, histórico, desfazer).

Ação concluída mostra toast com **Desfazer** (30 min já existentes em
`undo.ts`). Chief fora da 2031 vê a mesma folha; ao confirmar qualquer
item, o servidor devolve `chefe_de_plantao_outro` e abre o modal de 3.5.

Própria 2031: itens 1–3 aparecem como "Pedir ao admin" e disparam o
`chief_arrival_change.requested` existente.

### 3.3 Editor de horário (substitui `datetime-local` nas duas telas)

Componente novo `components/board/EditorDeHorario.tsx`, usado no cartão, na
gaveta e no turno anterior:

- Dia implícito: a janela do turno (SD 07–19, SN 19–07). Só se mostra data
  quando a janela cruza meia-noite e a hora é ambígua ("19:05 de ontem ·
  hoje").
- Presets como chips: `Início da janela (07:00)` · `Fim da janela (19:00)` ·
  `Agora`. Em cima, `−30 −15 −5 | HH:MM | +5 +15 +30`.
- `TimeScrubber` já pronto embaixo para arrastar (snap 5 min, marcas da
  janela).
- Linha de consequência ao vivo: "atraso 22 → 0 min · banco +0:00 →
  +0:00". O cálculo é `calculateBankHours` importado no cliente (puro).
- Motivo por chips, como em 3.2.

### 3.4 Seletor de posto (remanejar e, depois, chegada do plantonista)

Componente novo `components/board/SeletorDePosto.tsx`, mesma grade nos dois
usos:

- Abas **Regulação** / **Intervenção**. Grade de azulejos: código grande
  (`1362`, `CB02`), ocupante em cima, estado por cor: livre (verde), ocupado
  (cinza com nome), desativado (riscado), **origem atual** (destacada, não
  clicável). Eventuais numa linha à parte "Eventuais".
- Dados: o próprio snapshot do quadro (já tem tudo); eventuais por
  `listOnDemandRegulationPostOptions`.
- Toque num **livre**: confirma em um passo ("Mover Fulano 1362 → 1365").
- Toque num **ocupado**: segundo passo em linguagem simples, duas opções no
  máximo por domínio, nos termos de `semantica-trocas`: regulação →
  "Deslocar Beltrano (fica sem ramal)" ou "Trocar: Beltrano vai para…";
  intervenção → "Entrar como dupla" ou "Trocar". Mapeia para
  `conflictResolution` que a rota já aceita.
- Motivo: chips `Pedido da regulação` · `Reforço` · `Troca combinada` ·
  `Outro…`. Checkbox "sombra" vai para "Mais opções".
- Texto do rodapé passa a dizer a verdade: "a chegada no novo posto é agora;
  a hora prevista continua a do posto onde chegou".

Rota não muda (`POST /api/operational/transfers`). Só cliente.

## 4. Turno anterior — editar sem fazer conta

`app/historico/turno-anterior/client.tsx` e `PreviousShiftList.tsx`:

- Chegada e saída usam o `EditorDeHorario` (3.3) em vez do
  `InlineTimeEditor`. O `InlineTimeEditor` fica só como invólucro do popover
  ou é removido.
- Linha do médico mostra `Atraso de entrada: 22 min` como hoje, mas vira
  botão `Desconsiderar` (2.1).
- Novo bloco **Banco deste plantão**: saldo automático, chips `+15 +30 +60`
  `−15 −30`, motivo por chips, grava override (2.4). Mostra "manual" quando
  já houver override, com o autor.
- `DepartureVerifier` troca o `<input type="time">` pelo mesmo editor.

## 5. Tela do plantonista

Em `app/page.tsx`, quando `!mesaLiberada` **e** `session.doctorId` **e**
papel `doctor`: em vez de "Mesa fechada fora do plantão", renderiza
`components/medico/Chegar.tsx`:

1. "Olá, Fulano. Onde você está chegando?" → dois botões grandes
   **Regulação** / **Intervenção**.
2. `SeletorDePosto` (3.4) no modo plantonista: só livres clicáveis; ocupados
   em cinza com o nome; desativados riscados; eventuais escondidos.
3. Toque → confirmação de um botão: "Começar na 1362 agora (07:03)". Sem
   campo de hora.
4. `POST /api/medico/chegada` → `router.refresh()` → portão abre → quadro
   só leitura, com a **própria linha destacada** e um botão **Sair** no topo
   (`POST /api/medico/saida`, com confirmação de dois toques no mesmo botão,
   padrão `kairos.md`). Depois do toque: "Saída registrada às 19:02, a
   chefia confirma".
5. Já em turno ao entrar: pula direto para o quadro com a linha própria e o
   botão Sair.

Quem não é médico (tarm, rádio, portal, chief sem `doctorId`) continua vendo
a tela atual. Admin nunca cai aqui.

Fora do escopo desta entrega: refeição pelo plantonista (bot já faz),
continuação de turno, troca de ramal pelo próprio médico (regra de
`troca-ramal` é da chefia).

## 6. Entregas, em ordem, cada uma indo ao LIVE sozinha

| # | Entrega | Toca | Flag | Guarda |
|---|---|---|---|---|
| 0 | Domínio do abono: migration, calculator, sync, undo, evento, rota `POST …/occupancies/[id]/arrival-delay-waiver` | `db/`, `modules/bank-hours`, `modules/operational`, `app/api` | — (sem UI, zero efeito até alguém chamar) | teste puro + Postgres; `payment-duplicate-guard` segue |
| 0b | Sessão: nome + Sair fixos na barra; corte 07:15/19:15 (`ultimoCorte`, estado `virada`, tela sem senha); trava `chefe_de_plantao_outro` + modal 3.5 | `presenca.ts`, `mesa-presenca.service.ts`, `MesaPresenca.tsx`, `lib/auth/server.ts`, barra do cliente | `MESA_CORTE_VIRADA=1`, `MESA_TRAVA_2031=1` (sombra: só loga) | teste puro do corte (fuso SP, SD/SN, login antes/depois da virada); teste de rota barrada; `presenca-mesa.md` atualizado |
| 1 | Atraso no cartão + `chefeDePlantao` + folha de ações (itens 1, 2, 5, 6) | `board.service.ts`, `page.tsx`, cliente, CSS | `MESA_ACOES_RAPIDAS=1` | snapshot do quadro; teste de `chefeDePlantao` |
| 2 | `EditorDeHorario` no cartão e na gaveta | cliente | mesma flag | teste do cálculo ao vivo |
| 3 | `SeletorDePosto` no remanejo | cliente | `MESA_REMANEJO_V2=1` | nenhum servidor |
| 4 | Turno anterior: editor, abono, bônus (+ teto do chefe no override) | histórico, `overrides/route.ts` | — | teste do teto |
| 5 | Plantonista: `Chegar`, `/api/medico/chegada`, `/api/medico/saida`, Sair | `app/page.tsx`, `components/medico`, `app/api/medico`, `ocupacao-ativa.ts` | `MEDICO_CHEGADA_WEB=1` | route-auth-guard; teste 409 duplicata; teste alvo ocupado |

Cada flag por variável de ambiente lida no servidor, padrão desligado,
ligada no LIVE pelo `.env.production` + restart (ver memória
`pm2-env-shell-capture-magalu`). Rollback = desligar a flag ou revert.

Entrega 5 é independente de 1–4 (só compartilha o `SeletorDePosto`); pode
ir para outro agente em paralelo depois da 3, como o Caio sugeriu.

## 7. Perguntas que mudam o desenho (respostas assumidas até o Caio dizer)

1. Chefe de plantão = quem está na 2031 agora (decidido 01/10). Com a 2031
   **vazia**, qualquer chief em turno escreve. **Assumido**; alternativa é
   barrar tudo até alguém chegar na 2031.
1b. Corte da virada no portal (`mnrs-portal`, vale para Mesa e painel de
   vagas de uma vez) ou em cada app? **Assumido: cada app**, até conferir o
   portal. O corte no plantoes entra de qualquer jeito.
1c. Trava e corte nascem em **sombra** (só registram em `auditLogs` quem
   teria sido barrado) por alguns plantões antes de valer? **Assumido: sim**,
   mesmo caminho do `MESA_PRESENCA`.
2. Bônus de minutos: chefe de plantão com teto ±60, ou só admin?
   **Assumido: chefe com teto.**
3. Plantonista pode entrar em ramal ocupado (tomada) ou base ocupada (dupla)?
   **Assumido: não na primeira entrega.**
4. Nome do abono para o médico ver na folha e no banco: "atraso
   desconsiderado pela chefia"? **Assumido: sim, com o N original.**
5. `source` da chegada web: reusar `manual` ou criar `web`? **Assumido:
   `manual`** (sem migration de enum; só desempate de duplicata).

## 8. O que não fazer

- Não reaproveitar `lateArrivalAcknowledged*`: aposentado, só intervenção.
- Não deixar o plantonista escolher hora, desfecho ou posto ocupado.
- Não trocar o cálculo de prioridade de refeição/saída: só `startedAt`.
- Não mexer no `service.ts` do Telegram além de extrair
  `findActiveOccupancyByDoctorId`.
- Não quebrar `canManage` dos chiefs fora da 2031.
