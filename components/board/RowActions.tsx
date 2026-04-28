"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeftRight, ChevronRight, LogOut, Power, Repeat2, UserCog } from "lucide-react";
import { DeactivateDialog } from "@/components/board/DeactivateDialog";
import { DepartureDialog } from "@/components/board/DepartureDialog";
import { RolePicker } from "@/components/board/RolePicker";

interface RowActionsProps {
    domain: "regulation" | "intervention";
    targetId: number;
    targetCode: string;
    targetLabel: string;
    occupancyId: string | null;
    doctorName: string;
    currentRole: string | null;
    isDisabled: boolean;
    onOpenAdvanced?: () => void;
    onRemanejar?: () => void;
}

export function RowActions({
    domain,
    targetId,
    targetCode,
    targetLabel,
    occupancyId,
    doctorName,
    currentRole,
    isDisabled,
    onOpenAdvanced,
    onRemanejar,
}: RowActionsProps) {
    const [deactivateOpen, setDeactivateOpen] = useState(false);
    const [departureOpen, setDepartureOpen] = useState(false);

    return (
        <motion.div
            className="row-actions"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(event) => event.stopPropagation()}
        >
            <div className="row-actions__inner">
                {occupancyId && (
                    <RolePicker
                        domain={domain}
                        occupancyId={occupancyId}
                        currentRole={currentRole}
                        doctorName={doctorName}
                        targetCode={targetCode}
                    >
                        <UserCog size={13} strokeWidth={2.2} />
                        <span>{currentRole ?? "Função"}</span>
                    </RolePicker>
                )}

                {occupancyId && !isDisabled && (
                    <button
                        type="button"
                        className="row-action danger"
                        onClick={(event) => { event.stopPropagation(); setDepartureOpen(true); }}
                        title={`Declarar saída de ${doctorName}`}
                    >
                        <LogOut size={13} strokeWidth={2.2} />
                        <span>Declarar saída</span>
                    </button>
                )}

                <button
                    type="button"
                    className={`row-action ${isDisabled ? "info" : "warn"}`.trim()}
                    onClick={(event) => { event.stopPropagation(); setDeactivateOpen(true); }}
                    title={isDisabled ? `Reativar ${domain === "regulation" ? "ramal" : "USA"}` : `Desativar ${domain === "regulation" ? "ramal" : "USA"}`}
                >
                    <Power size={13} strokeWidth={2.2} />
                    <span>{isDisabled ? "Reativar" : "Desativar"}</span>
                </button>

                {occupancyId && !isDisabled && onRemanejar && (
                    <button
                        type="button"
                        className="row-action"
                        onClick={(event) => { event.stopPropagation(); onRemanejar(); }}
                        title={`Remanejar ${doctorName} para outro ramal/base (com justificativa interna)`}
                    >
                        <ArrowLeftRight size={13} strokeWidth={2.2} />
                        <span>Remanejar</span>
                    </button>
                )}

                {onOpenAdvanced && (
                    <button
                        type="button"
                        className="row-action ghost"
                        onClick={(event) => { event.stopPropagation(); onOpenAdvanced(); }}
                        title="Mais acoes: corrigir horario, encerrar com justificativa"
                    >
                        <Repeat2 size={13} strokeWidth={2.2} />
                        <span>Mais</span>
                        <ChevronRight size={11} strokeWidth={2.2} />
                    </button>
                )}
            </div>

            <DeactivateDialog
                open={deactivateOpen}
                onOpenChange={setDeactivateOpen}
                domain={domain}
                targetId={targetId}
                targetCode={targetCode}
                targetLabel={targetLabel}
                occupantName={isDisabled ? null : doctorName}
                isReactivate={isDisabled}
            />

            {occupancyId && (
                <DepartureDialog
                    open={departureOpen}
                    onOpenChange={setDepartureOpen}
                    domain={domain}
                    occupancyId={occupancyId}
                    targetCode={targetCode}
                    doctorName={doctorName}
                />
            )}
        </motion.div>
    );
}
