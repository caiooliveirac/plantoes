"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { ArrowRight, Calendar, Check, Search, Shield } from "lucide-react";
import { modalBackdrop } from "@/lib/board/motion";
import type { PendingDepartureConfirmation } from "@/services/board.service";

export interface CommandPaletteProps {
    pendingDepartures: PendingDepartureConfirmation[];
    onConfirm: (pending: PendingDepartureConfirmation) => Promise<unknown> | void;
    onOpenVerifier: (pending: PendingDepartureConfirmation) => void;
}

function isFromInputElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return target.isContentEditable;
}

function formatLocalHourMinute(iso: string) {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Cmd+K palette. Surfaces high-value actions for the chefe in one keystroke:
 *   - confirm next pending departure
 *   - open verifier for any pending doctor
 *   - jump to historical view
 *
 * Hotkeys outside the palette:
 *   - j / ↓: open verifier for first pending
 *   - Enter (while no input focused): quick-confirm first pending
 *
 * All hotkeys are no-ops when the focused element is text input — protects the
 * existing monolith forms from accidental triggers.
 */
export function CommandPalette({ pendingDepartures, onConfirm, onOpenVerifier }: CommandPaletteProps) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const onConfirmRef = useRef(onConfirm);
    const onOpenVerifierRef = useRef(onOpenVerifier);
    onConfirmRef.current = onConfirm;
    onOpenVerifierRef.current = onOpenVerifier;

    useEffect(() => {
        function handleKey(event: KeyboardEvent) {
            // Cmd/Ctrl + K opens regardless of focused input.
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setOpen((current) => !current);
                return;
            }

            // The remaining hotkeys are typing-safe.
            if (isFromInputElement(event.target)) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key === "Escape" && open) {
                setOpen(false);
                return;
            }
            if (pendingDepartures.length === 0) return;

            if (event.key === "j" || event.key === "ArrowDown") {
                event.preventDefault();
                onOpenVerifierRef.current(pendingDepartures[0]);
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                void onConfirmRef.current(pendingDepartures[0]);
                return;
            }
            if (event.key === "e" || event.key === "E") {
                event.preventDefault();
                onOpenVerifierRef.current(pendingDepartures[0]);
            }
        }
        document.addEventListener("keydown", handleKey);
        return () => document.removeEventListener("keydown", handleKey);
    }, [pendingDepartures, open]);

    const close = useCallback(() => {
        setOpen(false);
        setSearch("");
    }, []);

    const groupedPending = useMemo(() => pendingDepartures.slice(0, 8), [pendingDepartures]);

    return (
        <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close(); else setOpen(true); }}>
            <AnimatePresence>
                {open && (
                    <Dialog.Portal forceMount>
                        <Dialog.Overlay asChild>
                            <motion.div
                                className="departure-verifier-backdrop"
                                variants={modalBackdrop}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                            />
                        </Dialog.Overlay>
                        <Dialog.Content asChild>
                            <div className="command-palette-shell">
                                <motion.div
                                    className="command-palette-panel"
                                    initial={{ opacity: 0, y: -8, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 320, damping: 28 } }}
                                    exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.15 } }}
                                >
                                    <Dialog.Title style={{ position: "absolute", left: -9999 }}>Paleta de comandos</Dialog.Title>
                                    <Command label="Comandos" loop>
                                        <div className="command-palette-search">
                                            <Search size={16} strokeWidth={2.4} />
                                            <Command.Input
                                                value={search}
                                                onValueChange={setSearch}
                                                placeholder="Buscar médico, ramal, ou ação..."
                                                autoFocus
                                            />
                                            <kbd className="command-palette-kbd">Esc</kbd>
                                        </div>
                                        <Command.List className="command-palette-list">
                                            <Command.Empty>Nenhum resultado.</Command.Empty>

                                            {groupedPending.length > 0 && (
                                                <Command.Group heading="Saídas pendentes">
                                                    {groupedPending.map((pending) => (
                                                        <Command.Item
                                                            key={`confirm-${pending.occupancyId}`}
                                                            value={`confirmar ${pending.displayName ?? pending.doctorName} ${pending.targetCode}`}
                                                            onSelect={() => {
                                                                close();
                                                                void onConfirm(pending);
                                                            }}
                                                        >
                                                            <Check size={14} strokeWidth={2.4} />
                                                            <span>Confirmar saída — <strong>{pending.displayName ?? pending.doctorName}</strong> · {pending.targetCode} · {formatLocalHourMinute(pending.actualEndedAt)}</span>
                                                        </Command.Item>
                                                    ))}
                                                    {groupedPending.map((pending) => (
                                                        <Command.Item
                                                            key={`audit-${pending.occupancyId}`}
                                                            value={`auditar verificar ${pending.displayName ?? pending.doctorName} ${pending.targetCode}`}
                                                            onSelect={() => {
                                                                close();
                                                                onOpenVerifier(pending);
                                                            }}
                                                        >
                                                            <Shield size={14} strokeWidth={2.4} />
                                                            <span>Auditar — <strong>{pending.displayName ?? pending.doctorName}</strong> · {pending.targetCode}</span>
                                                        </Command.Item>
                                                    ))}
                                                </Command.Group>
                                            )}

                                            <Command.Group heading="Navegação">
                                                <Command.Item
                                                    value="plantao anterior fechamento"
                                                    onSelect={() => {
                                                        close();
                                                        router.push("/historico/turno-anterior");
                                                    }}
                                                >
                                                    <Calendar size={14} strokeWidth={2.4} />
                                                    <span>Abrir plantão anterior</span>
                                                </Command.Item>
                                                <Command.Item
                                                    value="historico operacional"
                                                    onSelect={() => {
                                                        close();
                                                        router.push("/historico-operacional");
                                                    }}
                                                >
                                                    <ArrowRight size={14} strokeWidth={2.4} />
                                                    <span>Histórico operacional</span>
                                                </Command.Item>
                                            </Command.Group>
                                        </Command.List>
                                    </Command>
                                </motion.div>
                            </div>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </AnimatePresence>
        </Dialog.Root>
    );
}
