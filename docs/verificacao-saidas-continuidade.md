# Verificação: fila de saídas e continuidade

Roteiro para conferir, **depois de uma virada de turno**, se as regras entregues em
2026-08-29 estão se comportando em produção. Feito para ser executado por um agente
no Mac, com acesso read-only (ver [agent-operations.md](agent-operations.md) §2 e §3).

O que subiu (PRs [#235](https://github.com/caiooliveirac/plantoes/pull/235) e
[#236](https://github.com/caiooliveirac/plantoes/pull/236)):

1. preview de banco de horas passa pela guarda — a tela para de prometer crédito que
   o servidor não grava;
2. permanência de 6h+ vira `extended_stay` na fila (plantão a assinar, não banco);
3. permanência de **10h+ sem sucessor** vira continuação sozinha, sem perguntar nada;
4. travessia de virada vale como continuidade **com ou sem** a palavra "continua";
5. `/corrigir` deixou de reescrever o titular vivo e de contaminar a evidência da saída;
6. card e modal abrem com `CHEGOU → SAIU`, com marca `+1d` quando atravessa o dia.

> **Quando rodar.** Depois de pelo menos uma virada (07:00 ou 19:00) com movimento
> real. Antes disso não há o que medir — as regras só agem sobre mensagens novas.

---

## 0. Preparo

```bash
# Túnel read-only (deixe rodando num terminal)
ssh -N -L 5433:localhost:5432 plantoes-prod
# Em outro terminal: $PLANTOES_RO_URL já aponta para localhost:5433
```

Confirme antes de tudo que o código no ar é o esperado:

```bash
ssh plantoes-prod 'curl -fsS http://127.0.0.1:3004/api/health' | python3 -m json.tool | grep commitSha
```

Precisa mostrar `928d229` ou posterior. Se mostrar menos que isso, **pare**: o deploy
não pegou e o resto da verificação não significa nada.

---

## 1. A regra das 10h disparou?

```sql
select d.full_name, p.code, o.shift_label,
       o.started_at, o.scheduled_end_at, o.actual_ended_at
from operations_v2.regulation_occupancies o
join operations_v2.doctors d on d.id = o.doctor_id
join operations_v2.regulation_posts p on p.id = o.post_id
where o.notes ilike '%continuacao reconhecida pela permanencia%'
  and o.updated_at >= now() - interval '48 hours'
order by o.updated_at desc;
```

**Zero linhas não é falha.** Só significa que ninguém emendou turno sem avisar nesse
período — o que é bom. Quem responde se a regra funciona é a consulta seguinte.

## 2. Alguém escapou dela? (o teste que falsifica)

```sql
select d.full_name, p.code, o.shift_label,
       o.scheduled_end_at, o.actual_ended_at,
       round(extract(epoch from (o.actual_ended_at - o.scheduled_end_at)) / 3600, 1) as sobra_h,
       (o.notes ilike '%continuacao reconhecida pela permanencia%') as marcado
from operations_v2.regulation_occupancies o
join operations_v2.doctors d on d.id = o.doctor_id
join operations_v2.regulation_posts p on p.id = o.post_id
where o.actual_ended_at >= now() - interval '48 hours'
  and o.scheduled_end_at is not null
  and o.actual_ended_at >= o.scheduled_end_at + interval '10 hours'
order by sobra_h desc;
```

**Esperado:** toda linha com `marcado = true`.

`marcado = false` com sobra de 10h+ é uma falha — **exceto** se aquela posição teve
sucessor (alguém assumiu o ramal), porque aí ele foi rendido e não emendou. Confira o
sucessor antes de concluir:

```sql
select d.full_name, o.started_at, o.ended_at
from operations_v2.regulation_occupancies o
join operations_v2.doctors d on d.id = o.doctor_id
where o.post_id = <post_id_da_linha_suspeita>
  and o.started_at between <scheduled_end_at> - interval '2 hours'
                       and <scheduled_end_at> + interval '4 hours'
order by o.started_at;
```

## 3. A continuidade está ligando as cadeias?

Esta é a mudança de maior alcance. O sinal é `board_started_at` anterior ao
`started_at` — a âncora herdada do plantão anterior.

```sql
select date_trunc('day', o.created_at at time zone 'America/Sao_Paulo') as dia,
       count(*) filter (where o.board_started_at < o.started_at) as com_ancora_herdada,
       count(*) as chegadas
from operations_v2.regulation_occupancies o
where o.created_at >= now() - interval '14 days'
  and o.board_started_at is not null
group by 1 order by 1 desc;
```

**Esperado:** a proporção `com_ancora_herdada / chegadas` deve **subir** a partir de
29/08 em relação aos dias anteriores. É a medida direta de "quem avisa tarde parou de
nascer órfão".

Se não subiu, não conclua que falhou: pode ser que ninguém tenha avisado tarde. Cruze
com o volume de mensagens de chegada fora da janela de 2h da virada.

## 4. O teto do banco de horas está valendo?

```sql
select count(*) filter (where credited_overtime_minutes > 720) as acima_do_teto,
       count(*) filter (where rule_code = 'EXTENDED_STAY_PAYABLE_SHIFT') as permanencias_longas,
       count(*) as total
from operations_v2.bank_hours_entries
where created_at >= now() - interval '48 hours';
```

**`acima_do_teto` tem de ser 0.** Nenhum plantão credita mais que 6h brutas (12h em
dobro). Qualquer número aí é regressão da guarda.

## 5. A janela do P sobreviveu ao /corrigir?

Corrigir a chegada de um P **encolhia** a janela agendada e fazia a fila propor um
plantão que não existe. Consertado em
[#237](https://github.com/caiooliveirac/plantoes/pull/237) — esta consulta virou
teste de regressão, não mais busca por um defeito esperado.

```sql
select d.full_name, p.code, o.shift_label,
       o.started_at, o.scheduled_end_at, o.actual_ended_at,
       round(extract(epoch from (o.actual_ended_at - o.scheduled_end_at)) / 3600, 1) as sobra_h
from operations_v2.regulation_occupancies o
join operations_v2.doctors d on d.id = o.doctor_id
join operations_v2.regulation_posts p on p.id = o.post_id
where o.shift_label = 'P'
  and o.notes ilike '%[telegram /corrigir]%'
  and o.updated_at >= now() - interval '48 hours'
  and o.actual_ended_at > o.scheduled_end_at + interval '6 hours';
```

Linha aqui = plantão fantasma na fila. **Não é plantão real** — não lance na folha, e
avise: é regressão do #237.

## 6. Toda correção deixou rastro?

```sql
select details->>'source' as origem, count(*)
from operations_v2.audit_logs
where action in ('regulation_occupancy.corrected', 'intervention_occupancy.corrected')
  and created_at >= now() - interval '48 hours'
group by 1 order by 2 desc;
```

**Esperado:** toda correção do período aparece, com a origem preenchida
(`telegram /corrigir`, `chefia confirmou a saida no quadro`, `correcao pela tela de
admin`…). Antes só as telas web gravavam — o bot não deixava before/after nenhum.

E confirme que o `/desfazer` volta a listar: no privado do bot, um admin manda
`/desfazer` e precisa ver ações recentes. **Lista vazia com correções no período é
falha** — era o estado anterior, causado por um `gt(created_at)` que fazia cada linha
superar a si mesma.

## 7. Erros novos

```bash
ssh plantoes-prod 'pm2 logs plantoes --lines 200 --nostream' | grep -iE "error|exception|unhandled" | tail -30
ssh plantoes-prod 'pm2 logs plantoes-telegram-worker --lines 200 --nostream' | grep -iE "error|exception" | tail -30
```

Procure especificamente por falhas em `correctRegulationOccupancy`,
`resolveUndeclaredContinuationScheduledEndAt` e `findTelegramContinuityContext`.

## 8. A tela

Abrir `https://plantoes.mnrs.com.br`, expandir **Saídas a confirmar** e conferir:

- cada card abre com `CHEGOU hh:mm → SAIU hh:mm`;
- turno que atravessa o dia mostra `+1d` em âmbar na saída;
- quem ficou 6h+ além da janela cai em **Precisa de decisão** com a frase de plantão a
  assinar — e **nenhum botão oferece "confirmar N h de banco de horas"**;
- o botão **Corrigir os horários** aparece em todos os casos, inclusive nas faixas de
  pagamento;
- chegada já corrigida no Telegram mostra o selo `/corrigir`.

---

## Como reportar

Uma linha por item: **ok**, **falhou** (com a linha do banco que prova) ou **sem dado**
(não houve caso no período). "Sem dado" é resposta legítima e não deve virar "ok".
