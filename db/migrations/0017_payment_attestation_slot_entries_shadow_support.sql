drop index if exists operations_v2.payment_attestation_slot_entries_target_idx;

create unique index payment_attestation_slot_entries_target_idx
    on operations_v2.payment_attestation_slot_entries(slot_id, domain, target_code, occupancy_id);
