import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDoctorName, parseDoctorImportFile, summarizeDoctorImport } from "@/modules/doctors/importer";

test("normalizes doctor names consistently", () => {
    assert.equal(normalizeDoctorName("Ana Beatriz D'Almeida Silva"), "ANA BEATRIZ D'ALMEIDA SILVA");
    assert.equal(normalizeDoctorName("  Monica Aragao  "), "MONICA ARAGAO");
});

test("parses csv imports", () => {
    const rows = parseDoctorImportFile(
        "doctors.csv",
        [
            "full_name,display_name,external_code",
            "Ana Beatriz D'Almeida Silva,Ana Beatriz,crm-1",
            "Monica Aragao,Monica,crm-2",
        ].join("\n"),
    );

    assert.equal(rows.length, 2);
    assert.equal(rows[0].fullName, "Ana Beatriz D'Almeida Silva");
    assert.equal(rows[1].displayName, "Monica");
});

test("summarizes duplicates and invalid rows", () => {
    const summary = summarizeDoctorImport([
        { fullName: "Ana Beatriz" },
        { fullName: "Ana Beatriz" },
        { fullName: "" },
    ]);

    assert.equal(summary.total, 3);
    assert.equal(summary.valid, 1);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.duplicates.length, 1);
});
