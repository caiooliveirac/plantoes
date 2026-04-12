import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_UNDO_WINDOW_MS, UNDO_WINDOW_MS } from "@/modules/operational/undo";
import {
    isTelegramUndoCommandText,
    parseTelegramUndoCommand,
} from "@/modules/telegram/admin-commands";

// ─── ADMIN_UNDO_WINDOW_MS ───────────────────────────────────────────

test("ADMIN_UNDO_WINDOW_MS is 12 hours", () => {
    assert.equal(ADMIN_UNDO_WINDOW_MS, 12 * 60 * 60 * 1000);
});

test("ADMIN_UNDO_WINDOW_MS is larger than UNDO_WINDOW_MS", () => {
    assert.ok(ADMIN_UNDO_WINDOW_MS > UNDO_WINDOW_MS);
});

// ─── isTelegramUndoCommandText ──────────────────────────────────────

test("detects /desfazer", () => {
    assert.ok(isTelegramUndoCommandText("/desfazer"));
});

test("detects /desfazer with number", () => {
    assert.ok(isTelegramUndoCommandText("/desfazer 3"));
});

test("detects /desfazer with bot suffix", () => {
    assert.ok(isTelegramUndoCommandText("/desfazer@samubot"));
});

test("detects /desfazer case-insensitive", () => {
    assert.ok(isTelegramUndoCommandText("/Desfazer"));
    assert.ok(isTelegramUndoCommandText("/DESFAZER 1"));
});

test("does not detect /corrigir as undo", () => {
    assert.ok(!isTelegramUndoCommandText("/corrigir PM04 20:00"));
});

test("does not detect plain text as undo", () => {
    assert.ok(!isTelegramUndoCommandText("desfazer"));
});

// ─── parseTelegramUndoCommand ───────────────────────────────────────

test("parses /desfazer as list command", () => {
    const result = parseTelegramUndoCommand("/desfazer");
    assert.ok(result);
    assert.equal(result.name, "undo_list");
    assert.equal(result.index, null);
});

test("parses /desfazer 1 as confirm command", () => {
    const result = parseTelegramUndoCommand("/desfazer 1");
    assert.ok(result);
    assert.equal(result.name, "undo_confirm");
    assert.equal(result.index, 1);
});

test("parses /desfazer 15 as confirm command", () => {
    const result = parseTelegramUndoCommand("/desfazer 15");
    assert.ok(result);
    assert.equal(result.name, "undo_confirm");
    assert.equal(result.index, 15);
});

test("parses /desfazer with bot suffix and number", () => {
    const result = parseTelegramUndoCommand("/desfazer@samubot 5");
    assert.ok(result);
    assert.equal(result.name, "undo_confirm");
    assert.equal(result.index, 5);
});

test("rejects /desfazer with index > 20", () => {
    const result = parseTelegramUndoCommand("/desfazer 21");
    assert.equal(result, null);
});

test("rejects /desfazer with index 0", () => {
    const result = parseTelegramUndoCommand("/desfazer 0");
    assert.equal(result, null);
});

test("rejects /desfazer with non-numeric argument", () => {
    const result = parseTelegramUndoCommand("/desfazer abc");
    assert.equal(result, null);
});

test("rejects /desfazer with mixed argument", () => {
    const result = parseTelegramUndoCommand("/desfazer 3abc");
    assert.equal(result, null);
});

// ─── Admin window logic ─────────────────────────────────────────────

test("admin window accepts actions from 6 hours ago", () => {
    const actionTime = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const elapsedMs = Date.now() - actionTime.getTime();
    assert.ok(elapsedMs <= ADMIN_UNDO_WINDOW_MS);
});

test("admin window rejects actions from 13 hours ago", () => {
    const actionTime = new Date(Date.now() - 13 * 60 * 60 * 1000);
    const elapsedMs = Date.now() - actionTime.getTime();
    assert.ok(elapsedMs > ADMIN_UNDO_WINDOW_MS);
});

test("admin window accepts actions from 11h59m ago", () => {
    const actionTime = new Date(Date.now() - (12 * 60 * 60 * 1000 - 60_000));
    const elapsedMs = Date.now() - actionTime.getTime();
    assert.ok(elapsedMs <= ADMIN_UNDO_WINDOW_MS);
});

test("regular window rejects 6h-old actions", () => {
    const actionTime = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const elapsedMs = Date.now() - actionTime.getTime();
    assert.ok(elapsedMs > UNDO_WINDOW_MS);
});
