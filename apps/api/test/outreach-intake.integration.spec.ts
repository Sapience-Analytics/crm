import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { db } from "@crm/db";
import {
	evidenceSchema,
	OUTREACH,
	type ProspectEvidence,
} from "@crm/validation/outreach";
import {
	importCandidatesInput,
	OUTREACH_INTAKE,
} from "@crm/validation/outreach-intake";
import { runOutreachIntake } from "../../agent/agent/lib/outreach-intake";
import * as research from "../../agent/agent/lib/outreach-research";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { OutreachService } from "../src/outreach/outreach.service";
import { OutreachIntakeService } from "../src/outreach/outreach-intake.service";

const ownerId = `intake-owner-${crypto.randomUUID()}`;
const outsiderId = `intake-outsider-${crypto.randomUUID()}`;
const now = new Date("2026-09-14T03:00:00.000Z");
const originalEnvironment = process.env.VERCEL_ENV;
const outreach = new OutreachService(db, new MailboxTokenService(db));
const service = new OutreachIntakeService(db, outreach);
const restores: (() => void)[] = [];
const checked: ProspectEvidence[] = [];
let sourceMatches = true;
let onCheck: ((evidence: ProspectEvidence) => Promise<void>) | null = null;
let owned = false;

function candidate() {
	const domain = `fleet-${crypto.randomUUID()}.intake.example.test`;
	return {
		company: "Isolated intake test fleet",
		domain,
		email: `fleet@${domain}`,
		industry: "transport",
		fleetBand: "unknown",
		fleetEvidence: "unknown",
		fit: "Operates delivery vehicles in Western Australia",
		sourceUrl: `https://${domain}/fleet`,
		sourceQuote: "We operate delivery vehicles across Perth.",
		waQuote: "Perth",
	};
}

async function importOne() {
	const input = importCandidatesInput.parse({ prospects: [candidate()] });
	const imported = await service.importCandidates(ownerId, input);
	const row = imported.rows[0];
	if (!row) throw new Error("Test import returned no candidate");
	return db.outreachProspect.findUniqueOrThrow({ where: { id: row.id } });
}

async function revisedPilot(manual: boolean) {
	const candidate = await importOne();
	await runOutreachIntake();
	checked.length = 0;
	const row = await db.outreachProspect.findUniqueOrThrow({
		where: { id: candidate.id },
	});
	return db.outreachProspect.update({
		where: { id: row.id },
		data: {
			status: manual ? "MANUAL" : "READY",
			manual,
			pilotSlot: manual ? 1 : 3,
			consent: {
				kind: "express",
				evidence:
					"Requested contact about fleet vehicle reporting and management.",
				source: "isolated-owner-request",
				roleRelevant: true,
				noRestriction: true,
				verifiedBy: ownerId,
				verifiedAt: now.toISOString(),
			},
			evidence: {
				...evidenceSchema.parse(row.evidence),
				sourceQuote:
					"We maintain safe, reliable and roadworthy delivery vehicles in Perth.",
				verified: false,
			},
			stopReason: OUTREACH_INTAKE.pendingReason,
			sourceVerificationAttempts: 0,
			sourceVerificationDueAt: now,
			emailDraftStatus: "PENDING",
		},
	});
}

beforeAll(async () => {
	if (
		(await db.outreachCampaign.count()) ||
		(await db.user.findFirst({ where: { email: OUTREACH.sender } }))
	)
		throw new Error("Requires an empty isolated outreach test workspace.");
	await db.user.createMany({
		data: [
			{
				id: ownerId,
				email: OUTREACH.sender,
				name: "Isolated intake owner",
				emailVerified: true,
			},
			{
				id: outsiderId,
				email: `${outsiderId}@example.test`,
				name: "Isolated outsider",
				emailVerified: true,
			},
		],
	});
	await outreach.initialize(ownerId);
	owned = true;
});

beforeEach(() => {
	setSystemTime(now);
	process.env.VERCEL_ENV = "production";
	checked.length = 0;
	sourceMatches = true;
	onCheck = null;
	const source = spyOn(research, "checkProspectSources").mockImplementation(
		async (evidence) => {
			checked.push(evidence);
			await onCheck?.(evidence);
			return sourceMatches;
		},
	);
	const network = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Live network is forbidden in intake integration tests"),
	);
	restores.push(
		() => source.mockRestore(),
		() => network.mockRestore(),
	);
});

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	if (owned) {
		await db.outreachDelivery.deleteMany({
			where: { prospect: { campaignId: OUTREACH.id } },
		});
		await db.outreachProspect.deleteMany({
			where: { campaignId: OUTREACH.id },
		});
		await db.contact.deleteMany({
			where: { ownerId: { in: [ownerId, outsiderId] } },
		});
		await db.company.deleteMany({ where: { ownerId } });
		await db.company.deleteMany({ where: { ownerId: outsiderId } });
		await db.outreachSuppression.deleteMany({
			where: { email: { endsWith: ".intake.example.test" } },
		});
		await db.suppressedContact.deleteMany({
			where: { email: { endsWith: ".intake.example.test" } },
		});
		await db.suppressedDomain.deleteMany({
			where: { domain: { endsWith: ".intake.example.test" } },
		});
	}
	setSystemTime();
	process.env.VERCEL_ENV = originalEnvironment;
});

afterAll(async () => {
	if (!owned) return;
	await db.outreachCampaign.delete({ where: { id: OUTREACH.id } });
	await db.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
});

describe("owner candidate intake", () => {
	test("refuses a signed-in non-owner before writing prospects", async () => {
		const input = importCandidatesInput.parse({ prospects: [candidate()] });
		await expect(service.importCandidates(outsiderId, input)).rejects.toThrow(
			"Only the campaign sender",
		);
		expect(
			await db.outreachProspect.count({ where: { campaignId: OUTREACH.id } }),
		).toBe(0);
	});

	test("queues only HELD unverified records without contacts or pilot state", async () => {
		const row = await importOne();
		expect(row.status).toBe("HELD");
		expect(evidenceSchema.parse(row.evidence).verified).toBe(false);
		expect(row.companyId).toBeNull();
		expect(row.contactId).toBeNull();
		expect(row.consent).toBeNull();
		expect(row.pilotSlot).toBeNull();
		expect(row.manual).toBe(false);
		expect(row.initialSentAt).toBeNull();
		expect(row.nextStage).toBe(0);
		expect(row.sourceVerificationAttempts).toBe(0);
		expect(row.sourceVerificationDueAt).not.toBeNull();
		expect(
			await db.outreachDelivery.count({ where: { prospectId: row.id } }),
		).toBe(0);
		expect(checked).toHaveLength(0);
	});

	test("deduplicates domains and emails without replacing existing evidence", async () => {
		const original = candidate();
		const input = importCandidatesInput.parse({
			prospects: [
				original,
				{ ...original, company: "Changed duplicate" },
				{ ...candidate(), email: original.email },
			],
		});
		const result = await service.importCandidates(ownerId, input);
		expect(result.queued).toBe(1);
		expect(result.duplicates).toBe(2);
		const row = await db.outreachProspect.findUniqueOrThrow({
			where: { domain: original.domain },
		});
		expect(evidenceSchema.parse(row.evidence).company).toBe(original.company);
		const repeated = await service.importCandidates(
			ownerId,
			importCandidatesInput.parse({
				prospects: [{ ...original, domain: `www.${original.domain}` }],
			}),
		);
		expect(repeated.queued).toBe(0);
		expect(repeated.duplicates).toBe(1);
	});

	test("parallel imports create one durable candidate", async () => {
		const input = importCandidatesInput.parse({ prospects: [candidate()] });
		const results = await Promise.all([
			service.importCandidates(ownerId, input),
			service.importCandidates(ownerId, input),
		]);
		expect(results.reduce((count, result) => count + result.queued, 0)).toBe(1);
		expect(
			results.reduce((count, result) => count + result.duplicates, 0),
		).toBe(1);
	});
});

describe("durable source verification", () => {
	for (const manual of [true, false])
		test(`reverifies revised ${manual ? "manual" : "automatic"} evidence without reallocating or changing identity`, async () => {
			const row = await revisedPilot(manual);
			await runOutreachIntake();
			await runOutreachIntake();
			const result = await db.outreachProspect.findUniqueOrThrow({
				where: { id: row.id },
			});
			expect(checked).toHaveLength(1);
			expect(evidenceSchema.parse(result.evidence)).toMatchObject({
				...evidenceSchema.parse(row.evidence),
				verified: true,
			});
			expect(result).toMatchObject({
				status: row.status,
				manual,
				pilotSlot: row.pilotSlot,
				companyId: row.companyId,
				contactId: row.contactId,
				domain: row.domain,
				email: row.email,
				consent: row.consent,
				emailDraftStatus: "PENDING",
				emailDrafts: null,
				sourceVerificationDueAt: null,
				stopReason: OUTREACH_INTAKE.revisionVerifiedReason,
			});
		});

	test("failed revised source checks remain unverified and preserve permanent manual allocation", async () => {
		const row = await revisedPilot(true);
		sourceMatches = false;
		await runOutreachIntake();
		const result = await db.outreachProspect.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(evidenceSchema.parse(result.evidence).verified).toBe(false);
		expect(result).toMatchObject({
			status: "MANUAL",
			manual: true,
			pilotSlot: 1,
			stopReason: OUTREACH_INTAKE.failedReason,
		});
		expect(result.sourceVerificationDueAt).not.toBeNull();
	});

	test("reverification cannot replace a deleted bound contact", async () => {
		const row = await revisedPilot(true);
		await db.contact.delete({ where: { id: row.contactId ?? "missing" } });
		await runOutreachIntake();
		const result = await db.outreachProspect.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(evidenceSchema.parse(result.evidence).verified).toBe(false);
		expect(result.contactId).toBe(row.contactId);
		expect(result.companyId).toBe(row.companyId);
		expect(result.stopReason).toBe(OUTREACH_INTAKE.bindingReason);
		expect(await db.contact.count({ where: { email: row.email } })).toBe(0);
	});

	for (const change of ["manual", "pilotSlot", "contactId"] as const)
		test(`revised verification cannot commit after concurrent ${change} drift`, async () => {
			const row = await revisedPilot(true);
			onCheck = async () => {
				await db.outreachProspect.update({
					where: { id: row.id },
					data:
						change === "manual"
							? { manual: false }
							: change === "pilotSlot"
								? { pilotSlot: 2 }
								: { contactId: "changed-contact" },
				});
			};
			await runOutreachIntake();
			const result = await db.outreachProspect.findUniqueOrThrow({
				where: { id: row.id },
			});
			expect(evidenceSchema.parse(result.evidence).verified).toBe(false);
		});

	for (const state of ["stopped", "delivery"] as const)
		test(`does not reverify ${state} pilot records`, async () => {
			const row = await revisedPilot(true);
			if (state === "stopped") {
				await db.outreachProspect.update({
					where: { id: row.id },
					data: { stoppedAt: now },
				});
			} else {
				await db.outreachDelivery.create({
					data: {
						prospectId: row.id,
						stage: 0,
						rfcMessageId: `${crypto.randomUUID()}@example.test`,
						subject: "Existing snapshot",
						body: "Existing snapshot",
						approvalHash: "isolated-test",
					},
				});
			}
			await runOutreachIntake();
			expect(checked).toHaveLength(0);
			expect(
				evidenceSchema.parse(
					(
						await db.outreachProspect.findUniqueOrThrow({
							where: { id: row.id },
						})
					).evidence,
				).verified,
			).toBe(false);
		});

	test("runs only in production", async () => {
		const row = await importOne();
		process.env.VERCEL_ENV = "preview";
		await runOutreachIntake();
		expect(checked).toHaveLength(0);
		expect(
			(await db.outreachProspect.findUniqueOrThrow({ where: { id: row.id } }))
				.sourceVerificationAttempts,
		).toBe(0);
	});

	test("verifies a bounded batch while preserving holds, consent and pilot exclusions", async () => {
		await service.importCandidates(
			ownerId,
			importCandidatesInput.parse({
				prospects: Array.from({ length: 4 }, candidate),
			}),
		);
		await runOutreachIntake();
		expect(checked).toHaveLength(OUTREACH_INTAKE.perTick);
		const rows = await db.outreachProspect.findMany({
			where: { campaignId: OUTREACH.id },
		});
		expect(
			rows.filter((row) => evidenceSchema.parse(row.evidence).verified),
		).toHaveLength(OUTREACH_INTAKE.perTick);
		for (const row of rows) {
			expect(row.status).toBe("HELD");
			expect(row.consent).toBeNull();
			expect(row.pilotSlot).toBeNull();
			if (evidenceSchema.parse(row.evidence).verified) {
				if (!row.email) throw new Error("Verified fixture has no email");
				expect(row.contactId).not.toBeNull();
				const contact = await db.contact.findUniqueOrThrow({
					where: { id: row.contactId ?? "missing" },
				});
				expect(contact.email).toBe(row.email);
				expect(contact.firstName).toBe(row.email);
				expect(contact.companyId).toBe(row.companyId);
				expect(contact.ownerId).toBe(ownerId);
				expect(contact.enrichmentStatus).toBe("SKIPPED");
			} else expect(row.contactId).toBeNull();
			expect(row.sourceVerificationLease).toBeNull();
		}
		const companies = await db.company.findMany({
			where: { ownerId },
			select: { id: true },
		});
		expect(
			await db.agentTask.count({
				where: { companyId: { in: companies.map((company) => company.id) } },
			}),
		).toBe(0);
	});

	test("concurrent worker ticks verify a candidate once", async () => {
		const row = await importOne();
		await Promise.all([runOutreachIntake(), runOutreachIntake()]);
		expect(checked).toHaveLength(1);
		expect(
			(await db.outreachProspect.findUniqueOrThrow({ where: { id: row.id } }))
				.sourceVerificationAttempts,
		).toBe(1);
	});

	test("binds an exact official contact on a parent-company email domain", async () => {
		const input = importCandidatesInput.parse({
			prospects: [
				{
					...candidate(),
					email: `fleet-${crypto.randomUUID()}@parent.intake.example.test`,
				},
			],
		});
		await service.importCandidates(ownerId, input);
		await runOutreachIntake();
		const row = await db.outreachProspect.findFirstOrThrow({
			where: { campaignId: OUTREACH.id },
		});
		const contact = await db.contact.findUniqueOrThrow({
			where: { id: row.contactId ?? "missing" },
		});
		expect(contact.companyId).toBe(row.companyId);
		expect(contact.email).toBe(row.email);
		expect(contact.email?.endsWith("@parent.intake.example.test")).toBe(true);
		expect(evidenceSchema.parse(row.evidence).verified).toBe(true);
	});

	test("reuses the existing exact active contact without changing its name", async () => {
		const row = await importOne();
		const company = await db.company.create({
			data: { domain: row.domain, name: "Existing fleet", ownerId },
		});
		const contact = await db.contact.create({
			data: {
				email: row.email,
				firstName: "Existing published name",
				ownerId,
				companyId: company.id,
			},
		});
		await runOutreachIntake();
		const result = await db.outreachProspect.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(result.contactId).toBe(contact.id);
		expect(result.companyId).toBe(company.id);
		expect(
			(await db.contact.findUniqueOrThrow({ where: { id: contact.id } }))
				.firstName,
		).toBe("Existing published name");
	});

	for (const conflict of [
		"contact-company",
		"contact-owner",
		"contact-archived",
		"company-owner",
		"company-archived",
		"suppressed",
		"suppressed-contact",
		"suppressed-company-domain",
		"suppressed-email-domain",
	] as const)
		test(`holds ${conflict} conflicts without reassigning existing records`, async () => {
			const row = await importOne();
			const company = await db.company.create({
				data: {
					domain: row.domain,
					name: "Existing fleet",
					ownerId: conflict === "company-owner" ? outsiderId : ownerId,
					archivedAt: conflict === "company-archived" ? now : null,
				},
			});
			const contact = await db.contact.create({
				data: {
					email: row.email,
					firstName: "Preserved existing contact",
					companyId: conflict === "contact-company" ? null : company.id,
					ownerId: conflict === "contact-owner" ? outsiderId : ownerId,
					archivedAt: conflict === "contact-archived" ? now : null,
				},
			});
			if (conflict === "suppressed" && row.email)
				await db.outreachSuppression.create({
					data: { email: row.email, reason: "Isolated test suppression" },
				});
			if (conflict === "suppressed-contact" && row.email)
				await db.suppressedContact.create({ data: { email: row.email } });
			if (conflict === "suppressed-company-domain")
				await db.suppressedDomain.create({ data: { domain: row.domain } });
			if (conflict === "suppressed-email-domain") {
				const email = `fleet-${crypto.randomUUID()}@parent.intake.example.test`;
				await db.outreachProspect.update({
					where: { id: row.id },
					data: {
						email,
						evidence: { ...evidenceSchema.parse(row.evidence), email },
					},
				});
				await db.suppressedDomain.create({
					data: { domain: "parent.intake.example.test" },
				});
			}
			await runOutreachIntake();
			const result = await db.outreachProspect.findUniqueOrThrow({
				where: { id: row.id },
			});
			expect(result.status).toBe("HELD");
			expect(result.companyId).toBeNull();
			expect(result.contactId).toBeNull();
			expect(result.sourceVerificationDueAt).toBeNull();
			expect(result.stopReason).toBe(OUTREACH_INTAKE.bindingReason);
			expect(evidenceSchema.parse(result.evidence).verified).toBe(false);
			expect(
				await db.contact.findUniqueOrThrow({ where: { id: contact.id } }),
			).toEqual(contact);
		});

	test("reclaims an expired worker lease after a restart", async () => {
		const row = await importOne();
		await db.outreachProspect.update({
			where: { id: row.id },
			data: {
				sourceVerificationAttempts: 1,
				sourceVerificationLease: "abandoned-worker",
				sourceVerificationLeaseUntil: new Date(
					now.getTime() + OUTREACH.leaseMs,
				),
			},
		});
		await runOutreachIntake();
		expect(checked).toHaveLength(0);
		setSystemTime(new Date(now.getTime() + OUTREACH.leaseMs + 1));
		await runOutreachIntake();
		const result = await db.outreachProspect.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(checked).toHaveLength(1);
		expect(result.sourceVerificationAttempts).toBe(2);
		expect(evidenceSchema.parse(result.evidence).verified).toBe(true);
	});

	test("exhausts three failed attempts without creating companies or retrying forever", async () => {
		const row = await importOne();
		sourceMatches = false;
		for (let attempt = 0; attempt < OUTREACH_INTAKE.maxAttempts; attempt++) {
			setSystemTime(
				new Date(now.getTime() + attempt * (OUTREACH_INTAKE.retryMs + 1)),
			);
			await runOutreachIntake();
		}
		setSystemTime(new Date(now.getTime() + OUTREACH.dayMs));
		await runOutreachIntake();
		const result = await db.outreachProspect.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(checked).toHaveLength(OUTREACH_INTAKE.maxAttempts);
		expect(result.sourceVerificationAttempts).toBe(OUTREACH_INTAKE.maxAttempts);
		expect(result.sourceVerificationDueAt).toBeNull();
		expect(result.stopReason).toBe(OUTREACH_INTAKE.exhaustedReason);
		expect(result.companyId).toBeNull();
		expect(evidenceSchema.parse(result.evidence).verified).toBe(false);
	});

	test("retires an exhausted lease left by a crashed final attempt", async () => {
		const row = await importOne();
		await db.outreachProspect.update({
			where: { id: row.id },
			data: {
				sourceVerificationAttempts: 3,
				sourceVerificationLease: "crashed-final-attempt",
				sourceVerificationLeaseUntil: new Date(now.getTime() - 1),
			},
		});
		await runOutreachIntake();
		const result = await db.outreachProspect.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(result.sourceVerificationDueAt).toBeNull();
		expect(result.sourceVerificationLease).toBeNull();
		expect(result.stopReason).toBe(OUTREACH_INTAKE.exhaustedReason);
		expect(checked).toHaveLength(0);
	});

	test("preserves a concurrent successful verification when the older source check fails", async () => {
		const row = await importOne();
		sourceMatches = false;
		onCheck = async (evidence) => {
			await db.outreachProspect.update({
				where: { id: row.id },
				data: {
					evidence: { ...evidence, verified: true },
					stopReason: OUTREACH_INTAKE.verifiedReason,
					sourceVerificationDueAt: null,
				},
			});
		};
		await runOutreachIntake();
		const result = await db.outreachProspect.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(evidenceSchema.parse(result.evidence).verified).toBe(true);
		expect(result.stopReason).toBe(OUTREACH_INTAKE.verifiedReason);
		expect(result.sourceVerificationDueAt).toBeNull();
	});

	for (const field of ["evidence", "domain", "email"] as const)
		test(`does not verify changed ${field} after an in-flight source read`, async () => {
			const row = await importOne();
			onCheck = async (evidence) => {
				const data =
					field === "evidence"
						? {
								evidence: {
									...evidence,
									sourceQuote:
										"New unverified fleet statement after the source read.",
								},
							}
						: field === "domain"
							? { domain: "changed.intake.example.test" }
							: { email: "changed@intake.example.test" };
				await db.outreachProspect.update({ where: { id: row.id }, data });
			};
			await runOutreachIntake();
			const result = await db.outreachProspect.findUniqueOrThrow({
				where: { id: row.id },
			});
			expect(evidenceSchema.parse(result.evidence).verified).toBe(false);
			expect(result.companyId).toBeNull();
			expect(result.status).toBe("HELD");
			expect(result.stopReason).toBe(OUTREACH_INTAKE.failedReason);
		});
});
