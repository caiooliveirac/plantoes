import assert from "node:assert/strict";
import test from "node:test";
import { getPasswordPolicyError, isPasswordPolicySatisfied } from "@/modules/auth/password-policy";

test("rejects passwords shorter than the minimum length", () => {
    assert.match(getPasswordPolicyError("Curta1!") ?? "", /pelo menos 10 caracteres/i);
});

test("rejects passwords without enough character groups", () => {
    assert.match(getPasswordPolicyError("somenteletras") ?? "", /tres grupos/i);
});

test("rejects reusing the same current password", () => {
    assert.match(getPasswordPolicyError("NovaSenha1!", "NovaSenha1!") ?? "", /diferente da senha atual/i);
});

test("accepts a strong password with mixed groups", () => {
    assert.equal(isPasswordPolicySatisfied("NovaSenha1!"), true);
});