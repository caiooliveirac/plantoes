-- Guarda o codinome em claro para o coordenador consultar/exportar depois.
-- As gerações novas (/resetcodinome, /pagamento codinome, resetar-todos) preenchem
-- esta coluna; linhas antigas (só-hash) ficam null até serem regeradas.
alter table operations_v2.doctor_payment_access
    add column if not exists codename text;
