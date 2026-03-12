/**
 * Motion presets for the modern operational board (Fatia 2+).
 *
 * Used with framer-motion. Centralized so springs/transitions stay consistent
 * across BoardGrid, AuditRail, DepartureVerifier, and the historical Gantt.
 *
 * Respect prefers-reduced-motion: framer-motion already short-circuits when
 * the user has the OS-level preference set, so these presets do not need
 * branching. The CSS-side durations in :root use a @media query for the
 * non-motion fallback (hover/focus transitions).
 */

import type { Transition, Variants } from "framer-motion";

// ── Springs ────────────────────────────────────────────────────────────────

/** Snappy interaction feedback — button taps, confirms, pulse-on-event. */
export const springSnappy: Transition = {
    type: "spring",
    stiffness: 520,
    damping: 32,
    mass: 0.7,
};

/** Layout transitions — magic move card→modal, panel reflow. */
export const springLayout: Transition = {
    type: "spring",
    stiffness: 280,
    damping: 30,
    mass: 0.9,
};

/** Soft entry/exit — audit rail items appearing, toasts. */
export const springSoft: Transition = {
    type: "spring",
    stiffness: 180,
    damping: 24,
    mass: 1.05,
};

// ── Common variants ───────────────────────────────────────────────────────

/** AnimatePresence-friendly fade with slight rise. */
export const fadeRise: Variants = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: springSoft },
    exit: { opacity: 0, y: 4, transition: { duration: 0.18, ease: [0.32, 0.72, 0, 1] } },
};

/** Stagger container for lists (audit rail, timeline). */
export const staggerList: Variants = {
    initial: {},
    animate: {
        transition: {
            staggerChildren: 0.045,
            delayChildren: 0.04,
        },
    },
};

/** Stagger child — pairs with `staggerList`. */
export const staggerChild: Variants = {
    initial: { opacity: 0, y: 10, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1, transition: springSoft },
};

/** Modal backdrop fade. */
export const modalBackdrop: Variants = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] } },
    exit: { opacity: 0, transition: { duration: 0.16, ease: [0.32, 0.72, 0, 1] } },
};

/** Modal panel — used WITH layoutId for magic-move from board card. */
export const modalPanel: Variants = {
    initial: { opacity: 0, scale: 0.96, y: 12 },
    animate: { opacity: 1, scale: 1, y: 0, transition: springLayout },
    exit: { opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.18 } },
};

/** Pulse loop — for new pending items that demand attention. */
export const pulseAttention = {
    boxShadow: [
        "0 0 0 0 rgba(224, 164, 88, 0.0)",
        "0 0 0 6px rgba(224, 164, 88, 0.18)",
        "0 0 0 0 rgba(224, 164, 88, 0.0)",
    ],
    transition: {
        duration: 2.4,
        ease: [0.32, 0.72, 0, 1] as [number, number, number, number],
        repeat: Infinity,
    },
};

/** Tap feedback — apply to motion.button via whileTap. */
export const tapFeedback = { scale: 0.96 };

/** Hover lift — apply via whileHover. */
export const hoverLift = { y: -1, transition: springSnappy };
