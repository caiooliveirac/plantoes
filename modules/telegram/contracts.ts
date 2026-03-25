export type TelegramConfidence = "high" | "medium" | "low";

export interface TelegramOperationalIntent {
    action: "start_regulation" | "end_regulation" | "start_intervention" | "end_intervention" | "needs_confirmation";
    confidence: TelegramConfidence;
    doctorQuery: string | null;
    targetCode: string | null;
    occurredAt: string | null;
    notes?: string | null;
}

export interface TelegramIngestionResult {
    accepted: boolean;
    reason: string;
    intent?: TelegramOperationalIntent;
}
