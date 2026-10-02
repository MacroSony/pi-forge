import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PI_PACKAGES, resolveTestVersions, validateExactVersion } from "../scripts/packed-versions.ts";

function fixture(t: { after(fn: () => void): void }, version = "1.0.0") {
	const root = mkdtempSync(join(tmpdir(), "forge-host-versions-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (name: string, value: unknown) => {
		const path = join(root, "node_modules", name, "package.json");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	};
	for (const name of PI_PACKAGES) put(name, { version, dependencies: { typebox: "1.3.27" } });
	put("typebox", { version: "1.3.7" });
	writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": "0.87.0" } }));
	return { root, put };
}

test("packed version validation accepts concrete releases and rejects ranges/specifiers/malformed input", () => {
	for (const version of ["0.87.0", "0.99.2", "1.0.0", "1.3.27"]) assert.equal(validateExactVersion("version", version), version);
	for (const value of ["", " ", " 1.0.0 ", "01.0.0", "1.0.0-beta.1", "1.0.0+meta", "latest", "^1.0.0", ">=0.87.0 <0.88.0", "file:../pi", "1.0.0; touch /tmp/unwanted", "1.0.0$(id)", "1.0.0\nnext", null, undefined, 123]) {
		assert.throws(() => validateExactVersion("version", value), /exact stable release/);
	}
});

test("packed defaults follow coherent installed Pi and its TypeBox dependency, not stale dev/root versions", (t) => {
	const { root } = fixture(t);
	assert.deepEqual(resolveTestVersions(root, {}), { piVersion: "1.0.0", typeboxVersion: "1.3.27" });
});

test("packed defaults reject mixed SDK family, missing packages, and unreadable manifests", (t) => {
	const { root, put } = fixture(t);
	put(PI_PACKAGES[0], { version: "0.87.0" });
	assert.throws(() => resolveTestVersions(root, {}), /Incoherent/);
	rmSync(join(root, "node_modules", PI_PACKAGES[0], "package.json"));
	assert.throws(() => resolveTestVersions(root, {}), /ENOENT/);
	writeFileSync(join(root, "node_modules", PI_PACKAGES[0], "package.json"), "not json");
	assert.throws(() => resolveTestVersions(root, {}), SyntaxError);
});

test("packed explicit target pair works independently of installed host", (t) => {
	const { root } = fixture(t);
	assert.deepEqual(resolveTestVersions(root, { PI_TEST_VERSION: "0.87.0", TYPEBOX_TEST_VERSION: "1.3.7" }), { piVersion: "0.87.0", typeboxVersion: "1.3.7" });
	assert.throws(() => resolveTestVersions(root, { PI_TEST_VERSION: "0.87.0" }), /Set TYPEBOX_TEST_VERSION/);
});

test("packed range-valued host TypeBox requires explicit target, never guessed lower bound", (t) => {
	const { root, put } = fixture(t);
	put("@earendil-works/pi-coding-agent", { version: "1.0.0", dependencies: { typebox: "^1.3.27" } });
	assert.throws(() => resolveTestVersions(root, {}), /exact stable release/);
	assert.deepEqual(resolveTestVersions(root, { TYPEBOX_TEST_VERSION: "1.3.28" }), { piVersion: "1.0.0", typeboxVersion: "1.3.28" });
});

test("packed explicit empty/invalid variables fail instead of silently falling back", (t) => {
	const { root } = fixture(t);
	for (const env of [{ PI_TEST_VERSION: "" }, { TYPEBOX_TEST_VERSION: "" }, { PI_TEST_VERSION: "latest", TYPEBOX_TEST_VERSION: "1.3.27" }, { TYPEBOX_TEST_VERSION: "^1.3.27" }]) {
		assert.throws(() => resolveTestVersions(root, env), /exact stable release/);
	}
});
