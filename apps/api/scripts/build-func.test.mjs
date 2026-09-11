import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
	readFileSync(join(scriptsDir, "../vercel.json"), "utf8"),
);

const runner = String.raw`
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const calls = [];
const databaseSource = (env) => {
  const keys = ["DIRECT_DATABASE_URL", "POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED", "DATABASE_URL"];
  return keys.find((key) => process.env[key] && process.env[key] === env.DATABASE_URL);
};

process.on("exit", () => {
  writeFileSync(join(fixtureRoot, "calls.json"), JSON.stringify(calls));
});

childProcess.execSync = (command, options) => {
  if (command.includes(" build serverless/index.ts")) {
    const encoded = command.split("--outfile=")[1].split(" --external ")[0];
    const target = JSON.parse(encoded);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "export default function handler() {}\n");
    calls.push({ kind: "bundle" });
    return;
  }
  if (command.endsWith(" x prisma migrate deploy")) {
    calls.push({ kind: "migrate", cwd: options.cwd, databaseSource: databaseSource(options.env) });
    if (process.env.TEST_MIGRATE_FAILURE === "1") throw new Error("Mock migration failure");
    return;
  }
  throw new Error("Unexpected build subprocess");
};

childProcess.spawnSync = (command, args, options) => {
  if (args.map((arg) => arg.replaceAll("\\", "/")).join(" ") !== "x prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code") {
    throw new Error("Unexpected schema comparison subprocess");
  }
  calls.push({ kind: "diff", cwd: options.cwd, databaseSource: databaseSource(options.env) });
  const status = process.env.TEST_DIFF_STATUS === "null" ? null : Number(process.env.TEST_DIFF_STATUS || "0");
  return { status, stdout: "", stderr: status === 1 ? "Mock comparison failure" : "" };
};

syncBuiltinESMExports();
await import(pathToFileURL(join(fixtureRoot, "apps/api/scripts/build-func.mjs")));
`;

function runBuild(t, env = {}, sourceConfig = config) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "crm-api-build-test-"));
	t.after(() => {
		assert.equal(dirname(realpathSync(fixtureRoot)), realpathSync(tmpdir()));
		rmSync(fixtureRoot, { recursive: true, force: true });
	});
	const apiDir = join(fixtureRoot, "apps/api");
	mkdirSync(join(apiDir, "scripts"), { recursive: true });
	mkdirSync(join(fixtureRoot, "packages/db"), { recursive: true });
	mkdirSync(join(fixtureRoot, ".vercel/output"), { recursive: true });
	writeFileSync(
		join(fixtureRoot, ".vercel/output/keep.txt"),
		"another project",
	);
	copyFileSync(
		join(scriptsDir, "build-func.mjs"),
		join(apiDir, "scripts/build-func.mjs"),
	);
	writeFileSync(join(apiDir, "vercel.json"), JSON.stringify(sourceConfig));
	writeFileSync(join(fixtureRoot, "runner.mjs"), runner);
	const node = process.versions.bun ? "node" : process.execPath;
	const childEnv = { PATH: process.env.PATH, ...env };
	if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
	const result = spawnSync(node, [join(fixtureRoot, "runner.mjs")], {
		cwd: apiDir,
		encoding: "utf8",
		env: childEnv,
	});
	assert.ifError(result.error);
	const calls = JSON.parse(
		readFileSync(join(fixtureRoot, "calls.json"), "utf8"),
	);
	return { ...result, calls, fixtureRoot, apiDir };
}

test("API output stays inside its project without duplicating the project crons", (t) => {
	const result = runBuild(t);
	assert.equal(result.status, 0, result.stderr);
	const outputDir = join(result.apiDir, ".vercel/output");
	const output = JSON.parse(
		readFileSync(join(outputDir, "config.json"), "utf8"),
	);
	assert.equal(output.version, 3);
	assert.deepEqual(output.routes, [{ src: "/(.*)", dest: "/api/index" }]);
	assert.equal(config.crons.length, 6);
	assert.ok(
		config.crons.some(
			(cron) =>
				cron.path === "/internal/outreach/dispatch" &&
				cron.schedule === "*/5 * * * *",
		),
	);
	assert.equal(Object.hasOwn(output, "crons"), false);
	assert.equal(
		new Set(config.crons.map((cron) => `${cron.path}:${cron.schedule}`)).size,
		6,
	);
	const functionDir = join(outputDir, "functions/api/index.func");
	const runtime = JSON.parse(
		readFileSync(join(functionDir, ".vc-config.json"), "utf8"),
	);
	assert.equal(runtime.runtime, "nodejs22.x");
	assert.equal(runtime.handler, "index.mjs");
	assert.ok(existsSync(join(functionDir, runtime.handler)));
	assert.equal(
		readFileSync(join(result.fixtureRoot, ".vercel/output/keep.txt"), "utf8"),
		"another project",
	);
	assert.deepEqual(
		result.calls.map((call) => call.kind),
		["bundle"],
	);
});

test("the bundled handler stays outside Vercel's automatic API directory", () => {
	const apiDir = dirname(scriptsDir);
	const nativeApiDir = join(apiDir, "api");
	const nativeFiles = existsSync(nativeApiDir)
		? readdirSync(nativeApiDir, { recursive: true })
		: [];
	assert.equal(
		nativeFiles.filter((file) => /\.(?:[cm]?[jt]sx?|py|go|rb|php)$/.test(file))
			.length,
		0,
	);
	assert.ok(existsSync(join(apiDir, "serverless/index.ts")));
	const tsconfig = JSON.parse(
		readFileSync(join(apiDir, "tsconfig.json"), "utf8"),
	);
	assert.ok(tsconfig.include.includes("serverless/**/*.ts"));
});

test("cron changes remain only in vercel.json after building", (t) => {
	const sourceConfig = {
		...config,
		crons: [{ path: "/internal/test-maintenance", schedule: "15 3 * * *" }],
	};
	const result = runBuild(t, {}, sourceConfig);
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(
		readFileSync(join(result.apiDir, ".vercel/output/config.json"), "utf8"),
	);
	const projectConfig = JSON.parse(
		readFileSync(join(result.apiDir, "vercel.json"), "utf8"),
	);
	assert.deepEqual(projectConfig.crons, sourceConfig.crons);
	assert.equal(Object.hasOwn(output, "crons"), false);
});

test("preview builds do not migrate even with a database configured", (t) => {
	const result = runBuild(t, {
		VERCEL: "1",
		VERCEL_ENV: "preview",
		DATABASE_URL: "database-test-value",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		result.calls.map((call) => call.kind),
		["bundle"],
	);
	assert.match(result.stdout, /preview deployment.*skipping migrations/);
});

test("production builds refuse a missing database", (t) => {
	const result = runBuild(t, { VERCEL: "1", VERCEL_ENV: "production" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /database URL is required/);
	assert.deepEqual(
		result.calls.map((call) => call.kind),
		["bundle"],
	);
});

const databaseKeys = [
	"DIRECT_DATABASE_URL",
	"POSTGRES_URL_NON_POOLING",
	"DATABASE_URL_UNPOOLED",
	"DATABASE_URL",
];

for (const [index, databaseKey] of databaseKeys.entries()) {
	test(`production migrations and comparison use ${databaseKey} in priority order`, (t) => {
		const env = Object.fromEntries(
			databaseKeys.slice(index).map((key) => [key, `${key}-test-value`]),
		);
		const result = runBuild(t, {
			VERCEL: "1",
			VERCEL_ENV: "production",
			...env,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(
			result.calls.map((call) => call.kind),
			["bundle", "migrate", "diff"],
		);
		for (const call of result.calls.slice(1)) {
			assert.equal(call.databaseSource, databaseKey);
			assert.equal(call.cwd, join(result.fixtureRoot, "packages/db"));
		}
		assert.match(result.stdout, /migrations applied/);
		assert.match(result.stdout, /schema matches/);
	});
}

for (const [status, reason] of [
	["2", /production schema does not match/],
	["1", /Could not verify the production database schema/],
	["null", /Could not verify the production database schema/],
]) {
	test(`production builds fail on schema comparison status ${status}`, (t) => {
		const result = runBuild(t, {
			VERCEL: "1",
			VERCEL_ENV: "production",
			DATABASE_URL: "database-test-value",
			TEST_DIFF_STATUS: status,
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, reason);
		assert.doesNotMatch(result.stdout, /schema matches/);
	});
}

test("production migration failures stop before schema comparison", (t) => {
	const result = runBuild(t, {
		VERCEL: "1",
		VERCEL_ENV: "production",
		DATABASE_URL: "database-test-value",
		TEST_MIGRATE_FAILURE: "1",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Mock migration failure/);
	assert.deepEqual(
		result.calls.map((call) => call.kind),
		["bundle", "migrate"],
	);
});
