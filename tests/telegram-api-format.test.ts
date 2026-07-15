import assert from "node:assert/strict";
import test from "node:test";
import {
    buildInlineKeyboard,
    escapeTelegramMarkdown,
    isCallbackButton,
    type TelegramInlineKeyboardButton,
} from "@/modules/telegram/api";

test("escapeTelegramMarkdown: texto limpo passa intacto", () => {
    assert.equal(escapeTelegramMarkdown("Vagner Costa 1363 SD 07:00"), "Vagner Costa 1363 SD 07:00");
    assert.equal(escapeTelegramMarkdown(""), "");
    assert.equal(escapeTelegramMarkdown("Acentuação é preservada: chegada às 07h"), "Acentuação é preservada: chegada às 07h");
});

test("escapeTelegramMarkdown: escapa asterisco", () => {
    assert.equal(escapeTelegramMarkdown("Ana *Beatriz*"), "Ana \\*Beatriz\\*");
});

test("escapeTelegramMarkdown: escapa underscore", () => {
    assert.equal(escapeTelegramMarkdown("dr_silva"), "dr\\_silva");
});

test("escapeTelegramMarkdown: escapa colchete de abertura", () => {
    assert.equal(escapeTelegramMarkdown("Luan [Sampaio]"), "Luan \\[Sampaio]");
});

test("escapeTelegramMarkdown: escapa crase", () => {
    assert.equal(escapeTelegramMarkdown("ramal `2035`"), "ramal \\`2035\\`");
});

test("escapeTelegramMarkdown: escapa todos os 4 chars ativos juntos, inclusive repetidos", () => {
    assert.equal(escapeTelegramMarkdown("_*`["), "\\_\\*\\`\\[");
    assert.equal(escapeTelegramMarkdown("**a__b``c[["), "\\*\\*a\\_\\_b\\`\\`c\\[\\[");
});

test("escapeTelegramMarkdown: não escapa chars inertes no Markdown v1 (], (, ), #, -)", () => {
    assert.equal(escapeTelegramMarkdown("a] (b) #c -d"), "a] (b) #c -d");
});

test("isCallbackButton: true para botão com callback_data", () => {
    const button: TelegramInlineKeyboardButton = { text: "☀️ SD", callback_data: "f6:sd:123" };
    assert.equal(isCallbackButton(button), true);
    if (isCallbackButton(button)) {
        // Narrowing: callback_data é string aqui, sem optional chaining.
        assert.equal(button.callback_data.startsWith("f6:"), true);
    }
});

test("isCallbackButton: false para botão de link (url) e para callback_data vazio", () => {
    assert.equal(isCallbackButton({ text: "Abrir privado", url: "https://t.me/bot" }), false);
    assert.equal(isCallbackButton({ text: "quebrado", callback_data: "" }), false);
    assert.equal(isCallbackButton({ text: "sem payload" }), false);
});

test("buildInlineKeyboard: aceita mistura de botões de callback e de url", () => {
    const rows: TelegramInlineKeyboardButton[][] = [
        [{ text: "☀️ SD", callback_data: "f6:sd:1" }, { text: "🌙 SN", callback_data: "f6:sn:1" }],
        [{ text: "💰 Pagamento no privado", url: "https://t.me/samu_bot" }],
    ];
    const markup = buildInlineKeyboard(rows);
    assert.deepEqual(markup, { inline_keyboard: rows });
});
