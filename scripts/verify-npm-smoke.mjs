import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = name => JSON.parse(readFileSync(join(process.env.RUNNER_TEMP, name), "utf8").replace(/^\uFEFF/, ""));
const doctor = read("doctor.json");
assert.deepEqual(doctor.components.map(component => component.id).sort(), ["browser", "java", "verapdf"]);
for (const component of doctor.components) {
	assert.equal(component.usable, true, component.id);
	assert.equal(component.source, "setup", component.id);
	assert.equal(component.pinned, true, component.id);
	assert.equal(component.inventory, "intact", component.id);
}
const pdf = read("pdf-report.json");
assert.equal(pdf.machineStatus, "complete");
assert.equal(pdf.pdfuaValidation.profile, "ua1");
assert.equal(pdf.pdfuaValidation.coverage.status, "complete");
assert.ok(pdf.findings.length > 0);
const html = read("html-report.json");
assert.equal(html.pages.length, 1);
assert.ok(html.pages.every(page => page.audited));
assert.equal(html.environment.components[0].source, "setup");
assert.equal(html.counts.confidence.high, 0);
console.log("PDF/UA validation complete; clean HTML page audited with the setup browser");
