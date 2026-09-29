-- Reverter a madrugada. As ocupações de cobertura viram registros comuns se a
-- coluna sumir (e entrariam no pagamento): apague-as antes.
delete from operations_v2.regulation_occupancies where madrugada_cobertura;
drop index if exists operations_v2.regulation_occupancies_madrugada_cobre_idx;
alter table operations_v2.regulation_occupancies
    drop column if exists madrugada_cobre_ocupacao_id,
    drop column if exists madrugada_cobertura;
update operations_v2.regulation_posts set is_active = false
where code in ('2266', '2267', '2268', '2269', '2270');
