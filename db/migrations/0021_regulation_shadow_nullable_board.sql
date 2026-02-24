-- Shadow coexistence on regulation posts.
--
-- A "sombra" (shadow) doctor accompanies the titular on the same ramal without
-- owning it. Coexistence is gated by the partial unique index
-- regulation_occupancies_one_active_board_per_post_idx, which allows at most one
-- ACTIVE occupancy WITH a board_started_at per post. The intervention domain lets
-- a shadow coexist by giving it board_started_at = NULL (so it stays outside that
-- index); regulation could not do the same because board_started_at was NOT NULL.
--
-- Drop the NOT NULL so a regulation shadow can be stored with board_started_at =
-- NULL when a titular already holds the board — mirroring the intervention model.
-- A shadow arriving on an empty post still takes the board (board_started_at set)
-- and becomes the visible occupant.
alter table operations_v2.regulation_occupancies
    alter column board_started_at drop not null;
