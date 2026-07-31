-- Saldo contratual dos plantonistas PJ (docs/saldo-contrato/SPEC.md §4, revisado
-- pelas decisões do usuário em 2026-07-31 — ver docs/saldo-contrato/00-levantamento.md §5).
--
-- Duas tabelas, não quatro. A renovação do contrato é ATO MANUAL do chefe: ele
-- cria o contrato novo já com o saldo de abertura que decidiu. Por isso não
-- existe rollover automático, não existe ciclo como entidade própria, e não
-- existe registro de pendência do estouro anterior — na renovação o chefe já
-- resolve isso ao digitar o saldo.
--
-- O saldo nunca é campo mutável: é a soma do razão append-only. O que muda é só
-- de onde vem o crédito de abertura (um lançamento 'opening'), não a mecânica.
--
-- Convive com operations_v2.doctor_contracts (semente teto+mês da 0026), que
-- segue alimentando o modal do fechamento até esta feature virar a chave.

create type operations_v2.contract_category as enum ('generalista', 'especialista', 'psiquiatria');
create type operations_v2.contract_status as enum ('active', 'suspended', 'terminated');
create type operations_v2.contract_ledger_entry_type as enum (
    'opening',            -- crédito de abertura (saldo importado ou digitado pelo coordenador)
    'invoice',            -- consumo de um fechamento atestado
    'invoice_reversal',   -- estorno (o admin desassinou a atestação)
    'manual_adjustment'   -- ajuste do admin (glosa, acerto, dobra)
);

-- Contrato PJ. Um médico pode ter mais de um ativo (ex.: Ana Beatriz D'Almeida,
-- 471/2024 + 455/2025): a atribuição fechamento -> contrato é por data, pela
-- janela [started_at, ended_at). Por isso não há unique por doctor_id.
--
-- Renovar = criar OUTRO registro, com superseded_by_contract_id apontando do
-- antigo para o novo, e um 'opening' com o saldo que o chefe definiu.
create table operations_v2.contracts (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id),

    contract_number varchar(40) not null,          -- "903/2024"
    company_name varchar(255),
    company_tax_id varchar(20),                    -- CNPJ, só dígitos

    category operations_v2.contract_category not null,
    -- Carga horária é DADO CADASTRAL: nenhum cálculo depende dela (SPEC §3.3).
    weekly_hours numeric(5, 1),

    -- Teto do ciclo. Nullable de propósito: no backfill de maio nem todo médico
    -- tem teto conhecido, e o coordenador preenche à mão depois. Sem teto o saldo
    -- ainda funciona; o que não dá para calcular é o percentual consumido.
    ceiling_amount numeric(14, 2),

    -- Janela do ciclo vigente. É o que permite projetar "acaba em dd/mm, e o
    -- ciclo só termina em dd/mm". Definida pelo chefe, não por rotina.
    cycle_start date not null,
    cycle_end date not null,                       -- exclusivo

    started_at date not null,
    ended_at date,                                 -- exclusivo

    status operations_v2.contract_status not null default 'active',
    superseded_by_contract_id uuid references operations_v2.contracts (id),
    notes text,

    created_by_user_id uuid references operations_v2.users (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint contracts_ceiling_positive check (ceiling_amount is null or ceiling_amount > 0),
    constraint contracts_window_ordered check (ended_at is null or ended_at > started_at),
    constraint contracts_cycle_ordered check (cycle_end > cycle_start)
);

create index contracts_doctor_idx on operations_v2.contracts (doctor_id);
create index contracts_status_doctor_idx on operations_v2.contracts (status, doctor_id);
-- Resolve "qual contrato deste médico vale na data X".
create index contracts_doctor_window_idx on operations_v2.contracts (doctor_id, started_at, ended_at);
-- O mesmo número de contrato não se repete ativo para o mesmo médico.
create unique index contracts_doctor_number_active_idx
    on operations_v2.contracts (doctor_id, contract_number)
    where status = 'active';

-- Razão append-only. Nada aqui é UPDATE nem DELETE: errou, lança o estorno.
-- Sinal do amount: positivo credita saldo, negativo consome.
create table operations_v2.contract_ledger (
    id uuid primary key default gen_random_uuid(),
    contract_id uuid not null references operations_v2.contracts (id),

    entry_date date not null,                      -- competência
    type operations_v2.contract_ledger_entry_type not null,
    amount numeric(14, 2) not null,

    -- Decomposição do consumo, alimenta a tradução do saldo em plantões.
    -- Meio plantão existe (a planilha registra "11,5" e "0,5").
    -- ATENÇÃO: um 'invoice_reversal' precisa trazer os plantões NEGATIVOS do
    -- lançamento que estorna. A view soma as colunas cruas; estorno sem isso
    -- devolve o dinheiro e deixa os plantões contados duas vezes.
    weekday_shifts numeric(6, 1) not null default 0,
    weekend_shifts numeric(6, 1) not null default 0,

    -- Origem. Não existe tabela payment_closings neste repo: o fechamento é
    -- (médico, mês) em payment_closing_attestations, e a linha é DELETADA quando
    -- o admin desassina. Por isso a chave é lógica e estável — 'uuid|AAAA-MM' —
    -- e não um FK para uma linha que some.
    source_type varchar(40),                       -- 'payment_closing_attestation'
    source_key varchar(80),                        -- '<doctorId>|<monthKey>'
    -- Nº da tentativa para a mesma origem: atestar=0, desatestar=1, reatestar=2...
    -- É o que impede dois 'invoice' vivos para o mesmo fechamento sem quebrar o
    -- append-only (o unique abaixo faz o serviço perder a corrida, não duplicar).
    source_revision integer not null default 0,

    invoice_number varchar(60),                    -- nota fiscal
    process_number varchar(60),                    -- processo SEI

    description text,
    created_by_user_id uuid references operations_v2.users (id),
    created_at timestamptz not null default now(),

    constraint contract_ledger_source_paired check (
        (source_type is null and source_key is null)
        or (source_type is not null and source_key is not null)
    ),
    constraint contract_ledger_revision_positive check (source_revision >= 0),
    -- Plantões em passos de 0,5.
    constraint contract_ledger_weekday_half_step check (mod(weekday_shifts * 10, 5) = 0),
    constraint contract_ledger_weekend_half_step check (mod(weekend_shifts * 10, 5) = 0)
);

create index contract_ledger_contract_idx on operations_v2.contract_ledger (contract_id, entry_date);
create unique index contract_ledger_source_revision_idx
    on operations_v2.contract_ledger (source_type, source_key, source_revision)
    where source_key is not null;

-- Saldo por contrato. Primeira view SQL do repo (o padrão até aqui é CTE ad-hoc
-- em services/*.service.ts). Volume é pequeno — ~150 contratos x ~12 lançamentos
-- por ano; se a listagem ficar lenta, materializar e refrescar no fechamento.
create or replace view operations_v2.contract_balance as
select
    c.id                              as contract_id,
    c.doctor_id,
    c.cycle_start,
    c.cycle_end,
    c.ceiling_amount                  as ceiling,
    coalesce(sum(l.amount) filter (where l.type = 'opening'), 0)                        as opening_balance,
    coalesce(sum(l.amount), 0)                                                          as balance,
    coalesce(-sum(l.amount) filter (where l.type <> 'opening'), 0)                      as consumed,
    coalesce(sum(l.weekday_shifts), 0) as weekday_shifts,
    coalesce(sum(l.weekend_shifts), 0) as weekend_shifts,
    max(l.entry_date) filter (where l.type = 'invoice')                                 as last_invoice_date
from operations_v2.contracts c
left join operations_v2.contract_ledger l on l.contract_id = c.id
group by c.id;
