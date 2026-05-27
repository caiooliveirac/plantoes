"use client";

import { useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { motion } from "framer-motion";
import { fadeRise, staggerChild, staggerList } from "@/lib/board/motion";
import type {
    PendingDepartureConfirmation,
    PreviousOperationalBucket,
    PreviousOperationalEntry,
} from "@/services/board.service";

const BUCKET_META: Record<PreviousOperationalBucket, { label: string; tone: "ice" | "gold" | "green" | "amber" }> = {
    P_INVERTIDO: { label: "P invertido", tone: "amber" },
    P: { label: "P", tone: "gold" },
    SD: { label: "SD — diurno", tone: "ice" },
    SN: { label: "SN — noturno", tone: "green" },
};

interface GanttRow {
    bucket: PreviousOperationalBucket;
    bucketLabel: string;
    lanes: PreviousOperationalEntry[][];
}

function entryStartMs(entry: PreviousOperationalEntry) {
    return new Date(entry.boardStartedAt ?? entry.startedAt).getTime();
}
function entryEndMs(entry: PreviousOperationalEntry) {
    return new Date(entry.actualEndedAt ?? entry.endedAt ?? entry.startedAt).getTime();
}

/** Packs entries into the minimum number of horizontal swim lanes that avoid overlap. */
function packLanes(entries: PreviousOperationalEntry[]): PreviousOperationalEntry[][] {
    const sorted = [...entries].sort((a, b) => entryStartMs(a) - entryStartMs(b));
    const lanes: PreviousOperationalEntry[][] = [];
    for (const entry of sorted) {
        const start = entryStartMs(entry);
        let placed = false;
        for (const lane of lanes) {
            const last = lane[lane.length - 1];
            if (entryEndMs(last) <= start) {
                lane.push(entry);
                placed = true;
                break;
            }
        }
        if (!placed) lanes.push([entry]);
    }
    return lanes;
}

function formatLocalHourMinute(ms: number) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function entryColorClass(entry: PreviousOperationalEntry, pending: PendingDepartureConfirmation | undefined) {
    if (pending) {
        if ((pending.delayMinutes ?? 0) >= 60 || pending.reasonOccurrenceCount30d >= 3) {
            return "fraud";
        }
        return "warn";
    }
    if (entry.status === "open") return "open";
    const delta = entry.balanceMinutes ?? 0;
    if (Math.abs(delta) >= 60) return "warn";
    return "confirm";
}

export function PreviousShiftGantt({
    entries,
    pendingByOccupancyId,
    onEntryClick,
}: {
    entries: PreviousOperationalEntry[];
    pendingByOccupancyId: Map<string, PendingDepartureConfirmation>;
    onEntryClick: (entry: PreviousOperationalEntry) => void;
}) {
    const { rangeStart, rangeEnd } = useMemo(() => {
        if (entries.length === 0) {
            const now = Date.now();
            return { rangeStart: now - 8 * 3600000, rangeEnd: now };
        }
        let start = Infinity;
        let end = -Infinity;
        for (const entry of entries) {
            start = Math.min(start, entryStartMs(entry));
            end = Math.max(end, entryEndMs(entry));
        }
        // Pad to whole hours.
        const HOUR = 3600000;
        start = Math.floor(start / HOUR) * HOUR;
        end = Math.ceil(end / HOUR) * HOUR;
        return { rangeStart: start, rangeEnd: end };
    }, [entries]);

    const rows: GanttRow[] = useMemo(() => {
        const byBucket = new Map<PreviousOperationalBucket, PreviousOperationalEntry[]>();
        for (const entry of entries) {
            const list = byBucket.get(entry.bucket) ?? [];
            list.push(entry);
            byBucket.set(entry.bucket, list);
        }
        const orderedBuckets: PreviousOperationalBucket[] = ["P_INVERTIDO", "P", "SD", "SN"];
        return orderedBuckets
            .map((bucket) => ({
                bucket,
                bucketLabel: BUCKET_META[bucket].label,
                lanes: packLanes(byBucket.get(bucket) ?? []),
            }))
            .filter((row) => row.lanes.length > 0);
    }, [entries]);

    const totalDurationMs = rangeEnd - rangeStart;
    const hourTicks = useMemo(() => {
        const HOUR = 3600000;
        const items: number[] = [];
        for (let t = rangeStart; t <= rangeEnd; t += HOUR) {
            items.push(t);
        }
        return items;
    }, [rangeStart, rangeEnd]);

    if (entries.length === 0) {
        return (
            <div className="historico-gantt-empty">
                Nenhum registro corresponde aos filtros atuais.
            </div>
        );
    }

    return (
        <motion.div
            className="historico-gantt"
            variants={fadeRise}
            initial="initial"
            animate="animate"
        >
            <div className="historico-gantt-axis">
                <div className="historico-gantt-axis__spacer" />
                <div className="historico-gantt-axis__hours">
                    {hourTicks.map((tick) => (
                        <span key={tick}>{formatLocalHourMinute(tick)}</span>
                    ))}
                </div>
            </div>

            <motion.div
                className="historico-gantt-rows"
                variants={staggerList}
                initial="initial"
                animate="animate"
            >
                {rows.map((row) => (
                    <motion.section
                        key={row.bucket}
                        className="historico-gantt-row"
                        variants={staggerChild}
                    >
                        <header className="historico-gantt-row__label">
                            <span className={`historico-gantt-row__tone tone-${BUCKET_META[row.bucket].tone}`} />
                            <strong>{row.bucketLabel}</strong>
                            <span>{row.lanes.flat().length} ocupações</span>
                        </header>
                        <div className="historico-gantt-row__lanes" style={{ "--lane-count": row.lanes.length } as React.CSSProperties}>
                            {row.lanes.map((lane, laneIndex) => (
                                <div key={laneIndex} className="historico-gantt-lane">
                                    {lane.map((entry) => {
                                        const start = entryStartMs(entry);
                                        const end = entryEndMs(entry);
                                        const pending = pendingByOccupancyId.get(entry.occupancyId);
                                        const left = ((start - rangeStart) / totalDurationMs) * 100;
                                        const width = Math.max(1.4, ((end - start) / totalDurationMs) * 100);
                                        const tone = entryColorClass(entry, pending);
                                        const balanceLabel = formatBalance(entry.balanceMinutes);
                                        return (
                                            <Popover.Root key={entry.occupancyId}>
                                                <Popover.Trigger asChild>
                                                    <button
                                                        type="button"
                                                        className={`historico-gantt-bar tone-${tone}`}
                                                        style={{ left: `${left}%`, width: `${width}%` }}
                                                        onClick={(event) => {
                                                            if (pending) {
                                                                event.preventDefault();
                                                                onEntryClick(entry);
                                                            }
                                                        }}
                                                        aria-label={`${entry.displayName ?? entry.doctorName} em ${entry.targetCode} de ${formatLocalHourMinute(start)} a ${formatLocalHourMinute(end)}`}
                                                    >
                                                        <span className="historico-gantt-bar__name">{entry.displayName ?? entry.doctorName}</span>
                                                        <span className="historico-gantt-bar__target">{entry.targetCode}</span>
                                                    </button>
                                                </Popover.Trigger>
                                                <Popover.Portal>
                                                    <Popover.Content sideOffset={6} className="historico-gantt-popover" collisionPadding={16}>
                                                        <header>
                                                            <strong>{entry.displayName ?? entry.doctorName}</strong>
                                                            <span>{entry.targetCode} · {entry.shiftLabel ?? "—"}{entry.roleLabel ? ` · ${entry.roleLabel}` : ""}</span>
                                                        </header>
                                                        <dl>
                                                            <div><dt>Chegada</dt><dd>{formatLocalHourMinute(start)}</dd></div>
                                                            <div><dt>Saída</dt><dd>{entry.actualEndedAt ? formatLocalHourMinute(end) : "Em aberto"}</dd></div>
                                                            <div><dt>Janela paga</dt><dd>{entry.scheduledStartAt && entry.scheduledEndAt ? `${formatLocalHourMinute(new Date(entry.scheduledStartAt).getTime())} — ${formatLocalHourMinute(new Date(entry.scheduledEndAt).getTime())}` : "—"}</dd></div>
                                                            <div><dt>Saldo</dt><dd className={Math.abs(entry.balanceMinutes ?? 0) >= 60 ? "warn" : ""}>{balanceLabel}</dd></div>
                                                            {entry.ruleCode && <div><dt>Regra</dt><dd>{entry.ruleCode}</dd></div>}
                                                        </dl>
                                                        {pending && (
                                                            <button
                                                                type="button"
                                                                className="historico-gantt-popover__action"
                                                                onClick={() => onEntryClick(entry)}
                                                            >
                                                                Abrir verificador →
                                                            </button>
                                                        )}
                                                        <Popover.Arrow className="historico-gantt-popover__arrow" />
                                                    </Popover.Content>
                                                </Popover.Portal>
                                            </Popover.Root>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                    </motion.section>
                ))}
            </motion.div>
        </motion.div>
    );
}

function formatBalance(minutes: number | null): string {
    if (minutes === null) return "—";
    const sign = minutes > 0 ? "+" : minutes < 0 ? "−" : "";
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const mins = abs % 60;
    if (hours > 0) return `${sign}${hours}h${String(mins).padStart(2, "0")}`;
    return `${sign}${mins}min`;
}
