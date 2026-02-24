-- Autoatendimento de pagamento por médico no Telegram (codinome).
--
-- O médico consulta o próprio pagamento no privado do bot enviando
-- /pagamento <codinome>. O coordenador gera o codinome (palavras+número) e entrega
-- no particular; ele é resetável (regerar sobrescreve o anterior). Guardamos apenas
-- o HMAC do codinome (pepper = AUTH_SECRET), nunca o valor em claro.
--
-- doctor_payment_access: 1 codinome ativo por médico (unique em doctor_id) e busca
-- O(1) por hash (unique em codename_hmac).
create table if not exists operations_v2.doctor_payment_access (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors(id) on delete cascade,
    codename_hmac text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists doctor_payment_access_doctor_idx
    on operations_v2.doctor_payment_access(doctor_id);
create unique index if not exists doctor_payment_access_codename_idx
    on operations_v2.doctor_payment_access(codename_hmac);

-- telegram_payment_access_attempts: anti-força-bruta por conta de Telegram. Conta
-- codinomes errados numa janela e trava temporariamente após o limite.
create table if not exists operations_v2.telegram_payment_access_attempts (
    telegram_user_id varchar(32) primary key,
    failed_count integer not null default 0,
    window_started_at timestamptz,
    locked_until timestamptz,
    updated_at timestamptz not null default now()
);
