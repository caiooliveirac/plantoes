# Remanejo a partir do NUCLEO — hora de chegada e banco de horas

Regra, defeito, correção no código e saneamento do passivo. Última revisão:
30/09/2026.

## A regra

**A hora prevista de chegada de um turno é a do posto onde o médico chegou.**
Só um ramal tem hora própria: o **NUCLEO abre às 08:00 no SD** (todo o resto
07:00 no SD e 19:00 no SN — `modules/operational/rules.ts`,
`NUCLEO_SD_START_HOUR`). Quem chega 07:50 no NUCLEO está no horário.

Quando esse médico é **remanejado** (quadro, `PATCH` com troca de ramal, ou bot
"Fulano mudou para 2151") para a CRU ou para uma ambulância, a exigência de
chegada **não muda**: ele não volta no tempo para ter chegado às 07:00. A janela
prevista do turno continua 08:00 → fim do destino (19:15 na regulação, 19:00 na
intervenção).

Consequências no banco de horas (`modules/bank-hours/calculator.ts`):

- atraso = primeira chegada do turno contra a hora do posto de chegada
  (tolerância de 15 min);
- **quem chegou no horário ganha o excedente de saída em dobro**; quem chegou
  atrasado ganha simples e ainda paga o atraso. Por isso um "atraso" inventado de
  50 min custava duas vezes: o débito e a metade da hora extra.

O caminho contrário não tem problema: quem chegou 07:00 na CRU e foi para o
NUCLEO deve 07:00 mesmo (chegou para um turno das 07:00).

## O defeito

O remanejo em si estava certo: `cloneOccupancyIntoTarget`
(`modules/operational/corrections.ts`) copia a janela da origem para o destino,
e o banco de horas mede o grupo de continuidade inteiro a partir da posição mais
antiga (`buildContinuityBankHoursSpan`). Mas **toda reinferência de janela
usava o posto ATUAL da ocupação**, e uma posição de destino tem posto ≠ NUCLEO:

| Caminho | O que gravava |
|---|---|
| Correção de turno + saída pelo admin no destino (`correctOccupancyShiftAndDeparture` → `correctRegulationOccupancy` com `shiftLabel`) | destino passava a 07:00 |
| Correção de horário no destino (`startedAt`/`boardStartedAt`) | destino passava a 07:00 |
| Chegada nova na CRU no mesmo turno depois do NUCLEO fechado (ADR-007 R1 herda o grupo) | posição nova nascia com 07:00 |
| Reenvio da chegada no destino (re-arrival in place) | destino passava a 07:00 |
| NUCLEO → ambulância: `inferInterventionCoverageWindow` nem aceitava posto | base sempre 07:00 |

Enquanto a ocupação do NUCLEO existia no grupo, o lançamento de banco seguia
certo (ele lê a posição mais antiga) e só a janela do destino ficava errada —
o que já mexe em réguas que leem a janela da própria posição (saída antecipada,
folha de ponto, atesto por turno). Quando a origem **não estava mais no grupo**
o lançamento também errava:

- **origem apagada** — o modelo antigo do remanejo (até 14/08/2026, caso Murilo)
  deletava a origem e o destino ficava com a chegada original; a chefia removeu
  a ocupação do NUCLEO pelo quadro; correções de duplicata;
- **turno partido** — NUCLEO num grupo de continuidade e o resto do turno em
  outro (ADR-007 mediu 69 turnos partidos em 90 dias, todas as origens);
- **dado anterior à regra do NUCLEO** — `scripts/repair-nucleo-scheduled-windows.ts`
  reparou só as ocupações **no** NUCLEO; as posições de destino de quem foi
  remanejado nunca foram tocadas.

Reproduzido em 30/09/2026 no banco local (cenário: NUCLEO 07:50 → 2151 às
10:00 → saída 19:40): com a origem apagada o banco gravava **atraso 50 min,
excedente simples, saldo −10 min**; o certo é **atraso 0, 40 min em dobro,
saldo +80 min**.

## A correção no código (PR desta data)

`modules/operational/posto-de-chegada.ts` responde "qual posto define a chegada
deste turno?" para uma posição que não é a primeira:

1. a posição mais antiga do mesmo grupo de continuidade nas últimas 13h (a
   chegada de fato) — ramal da regulação devolve o código; base devolve `null`;
2. sem posição anterior (origem apagada), a origem gravada nas notas pelo
   próprio remanejo (`Remanejado de NUCLEO para 2151.`, `Remanejado via
   Telegram de …`, `Remanejado por conflito operacional de …`);
3. sem nada disso, o posto atual.

Aplicado em `correctRegulationOccupancy`, `correctInterventionOccupancy`
(`inferInterventionCoverageWindow` ganhou `arrivalPostCode`),
`startRegulationOccupancy` e `startInterventionOccupancy` (posição nova que
herda grupo e reenvio no mesmo posto). Testes: `tests/posto-de-chegada.test.ts`
(puro) e `tests/remanejamento-nucleo-janela.test.ts` (banco — os quatro
cenários acima).

Fora do escopo desta correção, e por desenho: `syncBankHoursByContinuityGroup`
continua lendo a janela gravada da posição mais antiga do grupo. Quem junta
grupos partidos é a R1 do ADR-007 (`resolveTurnoContinuityGroupId`), já em
produção para chegadas novas.

## O passivo: `scripts/backfill-nucleo-remanejamento.ts`

Devolve o banco de horas dos turnos que **começaram no NUCLEO** e foram medidos
contra 07:00. Por grupo de continuidade:

| Evidência | O que é | Entra sozinho? |
|---|---|---|
| **E1** | a posição mais antiga do grupo é no NUCLEO (SD) | sim |
| **E2** | as notas da posição mais antiga dizem `Remanejado … de NUCLEO para …` (origem apagada) | sim |
| **E3** | `audit_logs` de `operational_occupancy.transferred` tem origem NUCLEO para uma posição do grupo, e essa origem começou antes/junto da posição mais antiga que sobrou | sim |
| **E5** | a mensagem do bot que criou a posição diz "remanejado do NUCLEO" (aceita; origem apagada, sem audit nem nota — caso Luiz, 26/04) | sim |
| **E4** | NUCLEO SD do mesmo médico, mesmo turno, em **outro** grupo (turno partido) | só com `--unir-grupos` (junta ao grupo do NUCLEO, o que a R1 faria hoje) |

Só toca a janela **07:00 → 08:00 do dia do turno** nas posições gravadas assim
e recalcula pelo mesmo caminho da aplicação (`syncBankHoursByContinuityGroup`):
override manual de saldo continua valendo (a prévia já mostra o override como
"depois"; ao unir turno partido ele migra para o grupo do NUCLEO na mesma
transação, e override nos dois grupos recusa a união até alguém decidir),
desfecho de saída antecipada gravado continua valendo, mês já atestado fica
fora por padrão. Não mexe em chegada nem
em saída. Cada posição alterada ganha uma linha em `audit_logs`
(`source = backfill NUCLEO remanejado …`, com `beforeSnapshot`/`afterSnapshot`)
— o undo do quadro reconhece o formato.

Prévia por turno: saldo gravado → saldo que o sync vai gravar, com delta; total
por médico no fim. Validado em 30/09/2026 em banco local com fixtures das quatro
evidências e dois controles (chegada na CRU depois NUCLEO; NUCLEO já certo):
os controles não aparecem e a segunda rodada não encontra nada.

### Runbook (no notebook, com SSH ao magalu)

Regra de ouro do CLAUDE.md: **nada roda no servidor**. O script roda no Mac,
com `DATABASE_URL` apontando para produção pelo túnel SSH
(`docs/agent-operations.md` §3). O dry-run pode usar o usuário read-only; o
`--apply` precisa do usuário de aplicação (read-write) — pegue a `DATABASE_URL`
do `.env.production` do servidor, **sem colar em lugar nenhum**.

```bash
# 0. código da main já com a correção (PR desta data mergeado e deployado)
git checkout main && git pull && npm ci

# 1. túnel (deixe rodando num terminal)
ssh -N -L 5433:localhost:5432 magalu

# 2. backup do banco ANTES de gravar (no Mac, via SSH — não roda no servidor além do pg_dump)
ssh magalu 'pg_dump -Fc -d plantoes' > ~/plantoes_pre_backfill_nucleo_$(date +%F).dump

# 3. dry-run, read-only
DATABASE_URL="$PLANTOES_RO_URL" npm run bank-hours:backfill-nucleo
DATABASE_URL="$PLANTOES_RO_URL" npm run bank-hours:backfill-nucleo -- --unir-grupos   # vê também os turnos partidos
DATABASE_URL="$PLANTOES_RO_URL" npm run bank-hours:backfill-nucleo -- --json > /tmp/backfill-nucleo-preview.json

# 4. leia a lista com a coordenação: médicos, datas, delta por turno, avisos ⚠
#    (override manual, desfecho de saída antecipada). Recorte se precisar:
#    --since=2026-03-01  --only=<grupo|ocupação>,...  --include-attested

# 5. aplicar (usuário read-write, pela mesma porta do túnel)
DATABASE_URL="postgres://<app_user>:<senha>@localhost:5433/plantoes?options=-csearch_path%3Doperations_v2" \
  npm run bank-hours:backfill-nucleo -- --apply [--unir-grupos] [--include-attested]

# 6. conferir: segunda rodada tem de dar zero; e o /admin/bank-hours dos médicos listados
DATABASE_URL="$PLANTOES_RO_URL" npm run bank-hours:backfill-nucleo -- --unir-grupos
```

Meses já atestados: o script os lista e pula. Se a coordenação decidir devolver
mesmo assim, `--include-attested`; o saldo do estatutário entra na folha do
mês do plantão (`modules/bank-hours/payroll.ts`), então avise quem fecha
a folha.

Voltar atrás: o dump do passo 2, ou, turno a turno, o `beforeSnapshot` das
linhas de `audit_logs` com `source` do backfill.

### Prompt pronto para a sessão no notebook

Cole numa sessão Claude Code aberta na raiz do repo, no Mac com SSH ao magalu:

> Leia `docs/remanejamento-nucleo-banco-horas.md` e `docs/agent-operations.md`
> §3. Quero rodar o saneamento `scripts/backfill-nucleo-remanejamento.ts`
> contra produção, a partir daqui (nada roda no servidor). Faça nesta ordem e
> me mostre a saída de cada passo antes do seguinte: (1) confira que a `main`
> local tem a correção (`modules/operational/posto-de-chegada.ts` existe) e que
> o deploy dela está no ar (`ssh magalu 'curl -fsS http://127.0.0.1:3004/api/health'`);
> (2) abra o túnel `ssh -N -L 5433:localhost:5432 magalu` em background e tire
> o backup `ssh magalu 'pg_dump -Fc -d plantoes' > ~/plantoes_pre_backfill_nucleo_$(date +%F).dump`;
> (3) rode o dry-run com `DATABASE_URL="$PLANTOES_RO_URL"` sem e com
> `--unir-grupos`, e me resuma: quantos turnos, quais médicos, delta total e por
> médico, quantos em mês atestado, quais têm ⚠ de override manual ou desfecho
> de saída antecipada; (4) me pergunte se aplico tudo, se recorto com
> `--since`/`--only`, e se incluo `--unir-grupos` e `--include-attested`;
> (5) só depois da minha resposta rode o `--apply` com a `DATABASE_URL` de
> aplicação que eu vou te passar na hora (não a grave em arquivo nem no
> histórico), depois rode o dry-run de novo (tem de dar zero) e abra
> `/admin/bank-hours` de dois dos médicos corrigidos para conferir o saldo.
> Não mexa em código nem faça commit; se algo der erro, pare e me mostre.

## Registro

| Data | O quê | Onde |
|---|---|---|
| 30/09/2026 | Defeito reproduzido em banco local (4 cenários), correção no código, testes, backfill escrito e validado com fixtures | este doc; `modules/operational/posto-de-chegada.ts`; `tests/remanejamento-nucleo-janela.test.ts`; `scripts/backfill-nucleo-remanejamento.ts` |
| 01/10/2026 | Backfill rodado em produção (com `--unir-grupos --include-attested`): 12 turnos, **+190 min** devolvidos (Luiz Eduardo +145 em 4 turnos, Ana Luiza Alves +45), 0 débito novo; mês mais antigo 04/2026. Adicionada a evidência E5. Segunda rodada: zero. Backup `~/plantoes_pre_backfill_nucleo_2026-10-01.dump` (schema operations_v2); desfazer turno a turno pelo `beforeSnapshot` em `audit_logs` | este doc; `scripts/backfill-nucleo-remanejamento.ts` |
