-- Papel `radio_operador` (modules/auth/contracts.ts): despacha unidades na
-- Central, sem escala. Lê a Mesa só na rede da Central e lá é isento da
-- presença (docs/presenca-mesa.md). Só acrescenta um valor ao enum: o código
-- antigo não o usa; aplicar ANTES do deploy.
alter type operations_v2.user_role add value if not exists 'radio_operador';
