import assert from "node:assert/strict";
import test from "node:test";
import { validateDoctorDirectoryInput } from "@/modules/doctors/service";

test("validateDoctorDirectoryInput trims and normalizes directory fields", () => {
    const parsed = validateDoctorDirectoryInput({
        fullName: "  Ana Beatriz D'Almeida Silva  ",
        displayName: " Ana Beatriz ",
        externalCode: " crm-1 ",
    });

    assert.deepEqual(parsed, {
        fullName: "Ana Beatriz D'Almeida Silva",
        displayName: "Ana Beatriz",
        externalCode: "crm-1",
        normalizedName: "ANA BEATRIZ D'ALMEIDA SILVA",
    });
});

test("validateDoctorDirectoryInput rejects names without usable letters", () => {
    assert.throws(
        () => validateDoctorDirectoryInput({ fullName: "---" }),
        /Nome completo do medico invalido/,
    );
});