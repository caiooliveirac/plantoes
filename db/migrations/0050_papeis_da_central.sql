-- Papéis dos operadores da Central (modules/auth/contracts.ts,
-- OPERADORES_DA_CENTRAL): `radio_operador` (despacho de unidades) e `tarm`
-- (telefonista). Sem médico vinculado: leem a Mesa só na rede da Central e lá
-- são isentos da presença (docs/presenca-mesa.md). Só acrescenta valores ao
-- enum: o código antigo não os usa; aplicar ANTES do deploy.
alter type operations_v2.user_role add value if not exists 'radio_operador';
alter type operations_v2.user_role add value if not exists 'tarm';
