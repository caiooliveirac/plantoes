"use client";

import { memo } from "react";
import type { CSSProperties, MouseEvent } from "react";
import type { PayableShift } from "@/modules/reporting/payable-shifts";
import { formatCurrency, formatUnits, type MatrixRowModel } from "./chief-payment-shared";

interface DoctorRowProps {
    row: MatrixRowModel;
    /** true na posição i quando board.days[i] é fim de semana/feriado (tarifa cheia). */
    premiumDays: boolean[];
    gridTemplate: string;
    virtualIndex: number;
    start: number;
    measureRef: (node: Element | null) => void;
    highlightKey: string | null;
    onOpenDoctor: (doctorId: string) => void;
    onOpenSlot: (payableShiftId: string) => void;
}

function chipClassName(shift: PayableShift, flash: boolean) {
    const parts = ["chief-matrix-chip", shift.shiftLabel === "SD" ? "sd" : "sn"];
    if (shift.source === "admin_extra") {
        parts.push(shift.paymentUnit < 0 ? "penalty" : "extra");
    }
    if (shift.paymentTag) {
        parts.push("half");
    }
    if (flash) {
        parts.push("flash");
    }
    return parts.join(" ");
}

function chipTitle(shift: PayableShift, doctorName: string) {
    if (shift.source === "admin_extra") {
        return `${shift.paymentUnit < 0 ? "Punição banco de horas" : "Plantão extra (admin)"} · ${shift.shiftLabel} · ${doctorName}`;
    }
    return `${shift.targetCode} ${shift.shiftLabel} · ${doctorName}${shift.paymentTag ? " · meio plantão" : ""}`;
}

function DoctorRowBase({
    row,
    premiumDays,
    gridTemplate,
    virtualIndex,
    start,
    measureRef,
    highlightKey,
    onOpenDoctor,
    onOpenSlot,
}: DoctorRowProps) {
    // Delegação: um handler por linha resolve o alvo via data-*, sem closure por chip.
    const handleClick = (event: MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        const chip = target.closest<HTMLElement>("[data-payable-id]");
        if (chip?.dataset.payableId) {
            onOpenSlot(chip.dataset.payableId);
            return;
        }
        if (target.closest("[data-doctor-open]")) {
            onOpenDoctor(row.doctorId);
        }
    };

    const style: CSSProperties = {
        gridTemplateColumns: gridTemplate,
        transform: `translateY(${start}px)`,
    };

    return (
        <div
            className="chief-matrix-row"
            role="row"
            data-index={virtualIndex}
            ref={measureRef}
            style={style}
            onClick={handleClick}
        >
            <div className="chief-matrix-doctor" role="rowheader">
                <button type="button" className="chief-matrix-doctor-button" data-doctor-open="true" title={row.isReady ? "Pronto para pagamento — abrir resumo" : "Com pendências — abrir resumo"}>
                    <span className={`chief-matrix-dot ${row.isReady ? "ready" : "review"}`.trim()} aria-hidden="true" />
                    <span className="chief-matrix-doctor-id">
                        <span className="chief-matrix-doctor-name">{row.doctorName}</span>
                        <span className="chief-matrix-doctor-badges">
                            {row.paymentProfile === "specialist" ? <em className="chief-matrix-badge esp">ESP</em> : null}
                            {row.paymentProfile === "psychiatry" ? <em className="chief-matrix-badge psiq">PSIQ</em> : null}
                            <em className={`chief-matrix-badge ${row.employmentType === "estatutario" ? "estat" : "pj"}`.trim()}>
                                {row.employmentType === "estatutario" ? "ESTATUTÁRIO" : "PJ"}
                            </em>
                            {row.pendingCount > 0 ? <em className="chief-matrix-badge pend">{row.pendingCount} PEND</em> : null}
                        </span>
                    </span>
                </button>
            </div>

            {row.cells.map((cell, index) => (
                <div key={cell.day} className={`chief-matrix-cell ${premiumDays[index] ? "we" : ""}`.trim()} role="gridcell">
                    {cell.shifts.map((shift) => {
                        const flash = highlightKey === `${shift.domain}|${shift.targetCode}|${cell.day}|${shift.shiftLabel}|assign`;
                        return (
                            <button
                                key={shift.payableShiftId}
                                type="button"
                                className={chipClassName(shift, flash)}
                                data-payable-id={shift.payableShiftId}
                                data-flash-key={`assign|${shift.domain}|${shift.targetCode}|${cell.day}|${shift.shiftLabel}`}
                                title={chipTitle(shift, row.doctorName)}
                            >
                                {shift.source === "admin_extra" ? shift.tagCode : shift.targetCode}
                                {shift.paymentTag ? <i aria-hidden="true">·½</i> : null}
                            </button>
                        );
                    })}
                </div>
            ))}

            <div className="chief-matrix-tot sd" role="gridcell">{row.totalSD > 0 ? formatUnits(row.totalSD) : "—"}</div>
            <div className="chief-matrix-tot sn" role="gridcell">{row.totalSN > 0 ? formatUnits(row.totalSN) : "—"}</div>
            <div className={`chief-matrix-due ${row.employmentType === "estatutario" ? "estat" : ""}`.trim()} role="gridcell">
                {formatCurrency(row.employmentType === "estatutario" ? 0 : row.totalDue)}
            </div>
        </div>
    );
}

export const DoctorRow = memo(DoctorRowBase);
