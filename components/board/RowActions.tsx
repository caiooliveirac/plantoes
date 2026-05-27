"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight, Power, Repeat2, UserCog } from "lucide-react";
import { DeactivateDialog } from "@/components/board/DeactivateDialog";
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
}: RowActionsProps) {
    const [deactivateOpen, setDeactivateOpen] = useState(false);

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
                        <UserCog size={14} strokeWidth={2.2} />
                        <span>Função{currentRole ? ` · ${currentRole}` : ""}</span>
                    </RolePicker>
                )}

                <button
                    type="button"
                    className={`row-action ${isDisabled ? "info" : "warn"}`.trim()}
                    onClick={(event) => { event.stopPropagation(); setDeactivateOpen(true); }}
                >
                    <Power size={14} strokeWidth={2.2} />
                    <span>{isDisabled ? `Reativar ${domain === "regulation" ? "ramal" : "USA"}` : `Desativar ${domain === "regulation" ? "ramal" : "USA"}`}</span>
                </button>

                {onOpenAdvanced && (
                    <button
                        type="button"
                        className="row-action ghost"
                        onClick={(event) => { event.stopPropagation(); onOpenAdvanced(); }}
                        title="Remanejar, transferir, encerrar ou continuar cobertura"
                    >
                        <Repeat2 size={14} strokeWidth={2.2} />
                        <span>Mais opções</span>
                        <ChevronRight size={12} strokeWidth={2.2} />
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
        </motion.div>
    );
}
