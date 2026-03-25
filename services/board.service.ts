import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { shouldKeepRegulationOccupancyVisible } from "@/modules/operational/board-rules";

export interface RegulationBoardRow {
  postId: number;
  occupancyId: string | null;
  postCode: string;
  postLabel: string;
  defaultRole: string | null;
  doctorId: string | null;
  doctorName: string | null;
  displayName: string | null;
  startedAt: string | null;
  boardStartedAt: string | null;
  scheduledEndAt: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  roleLabel: string | null;
  ramalLabel: string | null;
  status: "active" | "waiting";
  liveSource: "operations_v2" | "legacy_live" | "none";
  liveUpdatedAt: string | null;
}

export interface InterventionBoardRow {
  baseId: number;
  occupancyId: string | null;
  baseCode: string;
  baseLabel: string;
  doctorId: string | null;
  doctorName: string | null;
  displayName: string | null;
  startedAt: string | null;
  boardStartedAt: string | null;
  scheduledEndAt: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  roleLabel: string | null;
  status: "active" | "waiting";
  liveSource: "operations_v2" | "legacy_live" | "none";
  liveUpdatedAt: string | null;
}

function mapRegulationRow(row: Record<string, unknown>): RegulationBoardRow {
  return {
    postId: Number(row.postId ?? row.post_id),
    occupancyId: (row.occupancyId ?? row.occupancy_id ?? null) as string | null,
    postCode: String(row.postCode ?? row.post_code ?? ""),
    postLabel: String(row.postLabel ?? row.post_label ?? ""),
    defaultRole: (row.defaultRole ?? row.default_role ?? null) as string | null,
    doctorId: (row.doctorId ?? row.doctor_id ?? null) as string | null,
    doctorName: (row.doctorName ?? row.doctor_name ?? null) as string | null,
    displayName: (row.displayName ?? row.display_name ?? null) as string | null,
    startedAt: (row.startedAt ?? row.started_at ?? null) as string | null,
    boardStartedAt: (row.boardStartedAt ?? row.board_started_at ?? null) as string | null,
    scheduledEndAt: (row.scheduledEndAt ?? row.scheduled_end_at ?? null) as string | null,
    shiftLabel: (row.shiftLabel ?? row.shift_label ?? null) as RegulationBoardRow["shiftLabel"],
    roleLabel: (row.roleLabel ?? row.role_label ?? null) as string | null,
    ramalLabel: (row.ramalLabel ?? row.ramal_label ?? null) as string | null,
    status: String(row.status ?? "waiting") === "active" ? "active" : "waiting",
    liveSource: (row.liveSource ?? row.live_source ?? "none") as RegulationBoardRow["liveSource"],
    liveUpdatedAt: (row.liveUpdatedAt ?? row.live_updated_at ?? null) as string | null,
  };
}

function mapInterventionRow(row: Record<string, unknown>): InterventionBoardRow {
  return {
    baseId: Number(row.baseId ?? row.base_id),
    occupancyId: (row.occupancyId ?? row.occupancy_id ?? null) as string | null,
    baseCode: String(row.baseCode ?? row.base_code ?? ""),
    baseLabel: String(row.baseLabel ?? row.base_label ?? ""),
    doctorId: (row.doctorId ?? row.doctor_id ?? null) as string | null,
    doctorName: (row.doctorName ?? row.doctor_name ?? null) as string | null,
    displayName: (row.displayName ?? row.display_name ?? null) as string | null,
    startedAt: (row.startedAt ?? row.started_at ?? null) as string | null,
    boardStartedAt: (row.boardStartedAt ?? row.board_started_at ?? null) as string | null,
    scheduledEndAt: (row.scheduledEndAt ?? row.scheduled_end_at ?? null) as string | null,
    shiftLabel: (row.shiftLabel ?? row.shift_label ?? null) as InterventionBoardRow["shiftLabel"],
    roleLabel: (row.roleLabel ?? row.role_label ?? null) as string | null,
    status: String(row.status ?? "waiting") === "active" ? "active" : "waiting",
    liveSource: (row.liveSource ?? row.live_source ?? "none") as InterventionBoardRow["liveSource"],
    liveUpdatedAt: (row.liveUpdatedAt ?? row.live_updated_at ?? null) as string | null,
  };
}

export async function listRegulationBoard() {
  const db = getDb();
  const result = await db.execute(sql`
    with legacy_regulation as (
      select
        cs.ramal as post_code,
        app_user.doctor_id,
        coalesce(legacy_doctor.full_name, legacy_user.name) as doctor_name,
        legacy_doctor.display_name,
        cs.arrival_time as started_at,
        cs.arrival_time as board_started_at,
        si.scheduled_end_at,
        coalesce(cs.role_function_detected, si.role_function) as role_label,
        cs.ramal as ramal_label,
        cs.updated_at,
        row_number() over (
          partition by cs.ramal
          order by cs.arrival_time desc nulls last, cs.updated_at desc nulls last, cs.shift_instance_id asc
        ) as row_rank
      from public.shift_current_state cs
      inner join public.shift_instances si on si.id = cs.shift_instance_id
      left join operations_v2.users app_user on app_user.id = cs.executor_user_id
      left join operations_v2.doctors legacy_doctor on legacy_doctor.id = app_user.doctor_id
      left join public.users legacy_user on legacy_user.id = cs.executor_user_id
      where cs.status = 'CONFIRMED'
        and cs.departure_time is null
        and cs.ramal is not null
        and coalesce(si.scheduled_end_at, si.scheduled_start_at + interval '18 hours', now()) >= now() - interval '6 hours'
        and coalesce(si.scheduled_start_at, now()) <= now() + interval '6 hours'
    )
    select
      rp.id as "postId",
      ro.id as "occupancyId",
      rp.code as "postCode",
      rp.label as "postLabel",
      rp.default_role as "defaultRole",
      case
        when ro.id is not null and ro.source <> 'import' then d.id
        else coalesce(lr.doctor_id, d.id)
      end as "doctorId",
      case
        when ro.id is not null and ro.source <> 'import' then d.full_name
        else coalesce(lr.doctor_name, d.full_name)
      end as "doctorName",
      case
        when ro.id is not null and ro.source <> 'import' then d.display_name
        else coalesce(lr.display_name, d.display_name)
      end as "displayName",
      case
        when ro.id is not null and ro.source <> 'import' then ro.started_at
        else coalesce(lr.started_at, ro.started_at)
      end as "startedAt",
      case
        when ro.id is not null and ro.source <> 'import' then ro.board_started_at
        else coalesce(lr.board_started_at, ro.board_started_at)
      end as "boardStartedAt",
      case
        when ro.id is not null and ro.source <> 'import' then ro.scheduled_end_at
        else coalesce(lr.scheduled_end_at, ro.scheduled_end_at)
      end as "scheduledEndAt",
      case
        when ro.id is not null and ro.source <> 'import' then ro.shift_label
        else ro.shift_label
      end as "shiftLabel",
      case
        when ro.id is not null and ro.source <> 'import' then ro.role_label
        else coalesce(lr.role_label, ro.role_label)
      end as "roleLabel",
      case
        when ro.id is not null and ro.source <> 'import' then coalesce(ro.ramal_label, rp.code)
        else coalesce(lr.ramal_label, ro.ramal_label, rp.code)
      end as "ramalLabel",
      case when ro.id is not null or lr.post_code is not null then 'active' else 'waiting' end as "status",
      case
        when ro.id is not null and ro.source <> 'import' then 'operations_v2'
        when lr.post_code is not null then 'legacy_live'
        when ro.id is not null then 'operations_v2'
        else 'none'
      end as "liveSource",
      lr.updated_at as "liveUpdatedAt"
    from operations_v2.regulation_posts rp
    left join operations_v2.regulation_occupancies ro
      on ro.post_id = rp.id
     and ro.board_started_at is not null
     and ro.ended_at is null
    left join operations_v2.doctors d
      on d.id = ro.doctor_id
    left join legacy_regulation lr
      on lr.post_code = rp.code
     and lr.row_rank = 1
    where rp.is_active = true
    order by rp.sort_order asc, rp.code asc
  `);

  const rows = (result as unknown as Record<string, unknown>[]).map(mapRegulationRow);
  const reference = new Date();

  return rows.filter((row) => {
    if (row.status !== "active" || !row.doctorId) {
      return true;
    }

    return shouldKeepRegulationOccupancyVisible({
      startedAt: row.startedAt,
      shiftLabel: row.shiftLabel,
      reference,
    });
  });
}

export async function listInterventionBoard() {
  const db = getDb();
  const result = await db.execute(sql`
    with legacy_intervention as (
      select
        legacy_base.code as base_code,
        app_user.doctor_id,
        coalesce(legacy_doctor.full_name, legacy_user.name) as doctor_name,
        legacy_doctor.display_name,
        cs.arrival_time as started_at,
        cs.arrival_time as board_started_at,
        si.scheduled_end_at,
        coalesce(cs.role_function_detected, si.role_function) as role_label,
        cs.updated_at,
        row_number() over (
          partition by legacy_base.code
          order by cs.arrival_time desc nulls last, cs.updated_at desc nulls last, cs.shift_instance_id asc
        ) as row_rank
      from public.shift_current_state cs
      inner join public.shift_instances si on si.id = cs.shift_instance_id
      inner join public.bases legacy_base on legacy_base.id = si.base_id
      left join operations_v2.users app_user on app_user.id = cs.executor_user_id
      left join operations_v2.doctors legacy_doctor on legacy_doctor.id = app_user.doctor_id
      left join public.users legacy_user on legacy_user.id = cs.executor_user_id
      where cs.status = 'CONFIRMED'
        and cs.departure_time is null
        and cs.ramal is null
        and upper(coalesce(legacy_base.sector::text, '')) = 'INTERVENTION'
        and coalesce(si.scheduled_end_at, si.scheduled_start_at + interval '18 hours', now()) >= now() - interval '6 hours'
        and coalesce(si.scheduled_start_at, now()) <= now() + interval '6 hours'
    )
    select
      ib.id as "baseId",
      io.id as "occupancyId",
      ib.code as "baseCode",
      ib.label as "baseLabel",
      case
        when io.id is not null and io.source <> 'import' then d.id
        else coalesce(li.doctor_id, d.id)
      end as "doctorId",
      case
        when io.id is not null and io.source <> 'import' then d.full_name
        else coalesce(li.doctor_name, d.full_name)
      end as "doctorName",
      case
        when io.id is not null and io.source <> 'import' then d.display_name
        else coalesce(li.display_name, d.display_name)
      end as "displayName",
      case
        when io.id is not null and io.source <> 'import' then io.started_at
        else coalesce(li.started_at, io.started_at)
      end as "startedAt",
      case
        when io.id is not null and io.source <> 'import' then io.board_started_at
        else coalesce(li.board_started_at, io.board_started_at)
      end as "boardStartedAt",
      case
        when io.id is not null and io.source <> 'import' then io.scheduled_end_at
        else coalesce(li.scheduled_end_at, io.scheduled_end_at)
      end as "scheduledEndAt",
      case
        when io.id is not null and io.source <> 'import' then io.shift_label
        else io.shift_label
      end as "shiftLabel",
      case
        when io.id is not null and io.source <> 'import' then io.role_label
        else coalesce(li.role_label, io.role_label)
      end as "roleLabel",
      case when io.id is not null or li.base_code is not null then 'active' else 'waiting' end as "status",
      case
        when io.id is not null and io.source <> 'import' then 'operations_v2'
        when li.base_code is not null then 'legacy_live'
        when io.id is not null then 'operations_v2'
        else 'none'
      end as "liveSource",
      li.updated_at as "liveUpdatedAt"
    from operations_v2.intervention_bases ib
    left join operations_v2.intervention_occupancies io
      on io.base_id = ib.id
     and io.board_started_at is not null
     and io.ended_at is null
    left join operations_v2.doctors d
      on d.id = io.doctor_id
    left join legacy_intervention li
      on li.base_code = ib.code
     and li.row_rank = 1
    where ib.is_active = true
    order by ib.sort_order asc, ib.code asc
  `);

  return (result as unknown as Record<string, unknown>[]).map(mapInterventionRow);
}

export async function getOperationalBoard() {
  const [regulation, intervention] = await Promise.all([
    listRegulationBoard(),
    listInterventionBoard(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    regulation,
    intervention,
  };
}
