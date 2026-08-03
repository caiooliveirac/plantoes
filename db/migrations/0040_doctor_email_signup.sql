-- Autocadastro do médico por CODINOME + verificação de posse do email.
--
-- O fluxo antigo (0027) criava a conta por nome e dependia de ativação manual
-- da chefia. O novo fluxo troca as duas coisas: o codinome (doctor_payment_access)
-- prova a identidade, e um código de 6 dígitos enviado por email prova a posse
-- do endereço ANTES de a conta existir — evitando conta com email digitado errado,
-- que depois inviabilizaria a recuperação de senha.
--
-- Guardamos só o HMAC do código (mesmo padrão do codinome). attempt_count limita
-- força bruta por verificação; consumed_at marca a verificação que virou conta.

create table if not exists operations_v2.doctor_signup_email_verifications (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors(id) on delete cascade,
    email text not null,
    code_hmac text not null,
    expires_at timestamptz not null,
    attempt_count integer not null default 0,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists doctor_signup_email_verif_doctor_idx
    on operations_v2.doctor_signup_email_verifications (doctor_id, created_at desc);
create index if not exists doctor_signup_email_verif_email_idx
    on operations_v2.doctor_signup_email_verifications (email, created_at desc);
