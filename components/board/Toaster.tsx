"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * Project-wide toast provider. Mount once in app/layout.tsx.
 *
 * Visual choices:
 *   - top-right placement so it never collides with the audit rail (right edge)
 *     on operation chiefs' wide screens — wait, audit rail IS top-right too.
 *     Switch to bottom-right; toasts surface where the eye expects feedback.
 *   - dark theme aligned with --surface-elevated tokens.
 *   - rich colors disabled in favor of our semantic accent vars via inline
 *     style on offendant toasts — sonner respects custom classNames.
 */
export function Toaster() {
    return (
        <SonnerToaster
            position="bottom-right"
            theme="dark"
            duration={4500}
            closeButton
            toastOptions={{
                style: {
                    background: "var(--surface-elevated)",
                    border: "1px solid var(--surface-elevated-border)",
                    color: "var(--text)",
                    boxShadow: "var(--shadow-elevated)",
                    backdropFilter: "var(--blur-glass)",
                },
            }}
        />
    );
}
