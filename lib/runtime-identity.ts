import { execSync } from "node:child_process";
import os from "node:os";

export interface RuntimeIdentity {
    commitSha: string;
    commitShaLong: string;
    workingTreeClean: boolean | "unknown";
    runtimeSourceOfTruth: "pm2" | "docker" | "unknown";
    telegramDeliveryMode: "webhook" | "polling" | "unknown";
    port: string;
    hostname: string;
    authUrl: string;
    expectedWebhookUrl: string | null;
    timestamp: string;
}

let cachedCommitSha: string | null = null;
let cachedCommitShaLong: string | null = null;
const bootLogKeys = new Set<string>();

function resolveCommitSha() {
    if (cachedCommitSha) {
        return cachedCommitSha;
    }

    const fromEnv = process.env.GIT_COMMIT_SHA?.trim();
    if (fromEnv) {
        cachedCommitSha = fromEnv;
        return cachedCommitSha;
    }

    try {
        const value = execSync("git rev-parse --short HEAD", {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "ignore"],
        }).toString().trim();
        cachedCommitSha = value || "unknown";
        return cachedCommitSha;
    } catch {
        cachedCommitSha = "unknown";
        return cachedCommitSha;
    }
}

// Cache igual ao do sha curto: sem ele, todo POST do webhook (e todo /api/health)
// fazia um execSync de git, que bloqueia o event loop do processo inteiro.
function resolveCommitShaLong() {
    if (cachedCommitShaLong) {
        return cachedCommitShaLong;
    }

    const fromEnv = process.env.GIT_COMMIT_SHA_LONG?.trim();
    if (fromEnv) {
        cachedCommitShaLong = fromEnv;
        return cachedCommitShaLong;
    }
    try {
        cachedCommitShaLong = execSync("git rev-parse HEAD", {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "ignore"],
        }).toString().trim() || "unknown";
    } catch {
        cachedCommitShaLong = "unknown";
    }
    return cachedCommitShaLong;
}

function resolveWorkingTreeClean(): boolean | "unknown" {
    const fromEnv = process.env.GIT_WORKING_TREE_CLEAN?.trim().toLowerCase();
    if (fromEnv === "true") return true;
    if (fromEnv === "false") return false;
    return "unknown";
}

function resolveRuntimeSourceOfTruth() {
    const value = process.env.RUNTIME_SOURCE_OF_TRUTH?.trim().toLowerCase();
    if (value === "pm2" || value === "docker") {
        return value;
    }

    return "unknown";
}

function resolveTelegramDeliveryMode() {
    const value = process.env.TELEGRAM_DELIVERY_MODE?.trim().toLowerCase();
    if (value === "webhook" || value === "polling") {
        return value;
    }

    return "unknown";
}

function resolveExpectedWebhookUrl(authUrl: string) {
    if (!authUrl) {
        return null;
    }

    return `${authUrl.replace(/\/$/, "")}/api/telegram/webhook`;
}

export function getRuntimeIdentity(now = new Date()): RuntimeIdentity {
    const authUrl = process.env.AUTH_URL?.trim() ?? "";
    return {
        commitSha: resolveCommitSha(),
        commitShaLong: resolveCommitShaLong(),
        workingTreeClean: resolveWorkingTreeClean(),
        runtimeSourceOfTruth: resolveRuntimeSourceOfTruth(),
        telegramDeliveryMode: resolveTelegramDeliveryMode(),
        port: process.env.PORT?.trim() || "",
        hostname: os.hostname(),
        authUrl,
        expectedWebhookUrl: resolveExpectedWebhookUrl(authUrl),
        timestamp: now.toISOString(),
    };
}

export function assertSingleRuntimeConfig(entrypoint: string) {
    const identity = getRuntimeIdentity();
    const errors: string[] = [];

    if (identity.runtimeSourceOfTruth === "pm2" && identity.telegramDeliveryMode === "polling") {
        errors.push("TELEGRAM_DELIVERY_MODE=polling conflicts with RUNTIME_SOURCE_OF_TRUTH=pm2");
    }

    const explicitWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim() || "";
    if (identity.telegramDeliveryMode === "polling" && explicitWebhookUrl) {
        errors.push("TELEGRAM_DELIVERY_MODE=polling conflicts with TELEGRAM_WEBHOOK_URL configured");
    }

    if (errors.length > 0) {
        throw new Error(`[runtime-guard:${entrypoint}] ${errors.join("; ")}`);
    }

    return identity;
}

export function logRuntimeIdentity(entrypoint: string) {
    const key = `${entrypoint}:${process.pid}`;
    if (bootLogKeys.has(key)) {
        return;
    }

    bootLogKeys.add(key);
    const identity = getRuntimeIdentity();
    console.log(
        `[runtime] entrypoint=${entrypoint} commit=${identity.commitSha} runtime=${identity.runtimeSourceOfTruth} mode=${identity.telegramDeliveryMode} port=${identity.port || "-"} webhook=${identity.expectedWebhookUrl || "-"} host=${identity.hostname} ts=${identity.timestamp}`,
    );
}
