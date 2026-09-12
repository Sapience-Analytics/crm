import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { db } from "@crm/db";
import { reserveOutreachBudget } from "@crm/db/outreach-budget";
import {
	DEFAULT_TEMPLATES,
	evidenceSchema,
	OUTREACH,
} from "@crm/validation/outreach";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { GmailClient, type GmailMessage } from "../src/google/gmail.client";
import { GmailSyncService } from "../src/google/gmail-sync.service";
import { MailboxApiClient } from "../src/mailbox/mailbox-api.client";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { SyncStateService } from "../src/mailbox/sync-state.service";
import { ThreadWriterService } from "../src/mailbox/thread-writer.service";
import {
	campaignHash,
	OutreachService,
} from "../src/outreach/outreach.service";
import { OutreachDispatchService } from "../src/outreach/outreach-dispatch.service";
import { OutreachGmail } from "../src/outreach/outreach-gmail";

const userId = `outreach-test-${crypto.randomUUID()}`;
const companyId = `outreach-test-company-${crypto.randomUUID()}`;
const budgetId = `outreach-test-budget-${crypto.randomUUID()}`;
const now = new Date("2026-09-14T03:00:00.000Z");
const tokens = new MailboxTokenService(db);
const client = new GmailClient(new MailboxApiClient());
const gmail = new OutreachGmail(client);
const match: MailboxMatchService = Object.create(MailboxMatchService.prototype);
const writer = new ThreadWriterService(db, match, new ActivityStampService(db));
const parser = new GmailSyncService(
	db,
	client,
	tokens,
	new SyncStateService(db),
	writer,
);
const service = new OutreachService(db, tokens);
const dispatcher = new OutreachDispatchService(
	db,
	tokens,
	gmail,
	parser,
	writer,
);
const messages = new Map<string, GmailMessage>();
const sent = mock(
	async (_token: string, message: Parameters<OutreachGmail["send"]>[1]) =>
		accept(message),
);
const restores: (() => void)[] = [];
let owned = false;

function accept(
	message: Parameters<OutreachGmail["send"]>[1],
	rewritten = false,
) {
	const id = `sent-${crypto.randomUUID()}`;
	const threadId = message.threadId ?? `thread-${crypto.randomUUID()}`;
	messages.set(id, {
		id,
		threadId,
		internalDate: String(Date.now()),
		labelIds: ["SENT"],
		payload: {
			mimeType: "text/plain",
			headers: [
				{
					name: "Message-ID",
					value: `<${rewritten ? `CAPx-${id}@mail.gmail.com` : message.rfcId}>`,
				},
				{ name: "From", value: message.from },
				{ name: "To", value: message.to },
				{ name: "Subject", value: message.subject },
				...(message.rootId
					? [{ name: "References", value: `<${message.rootId}>` }]
					: []),
			],
			body: { data: Buffer.from(message.body).toString("base64url") },
		},
	});
	return { id, threadId };
}

function evidence(index: number) {
	return evidenceSchema.parse({
		company: `Test Fleet ${index}`,
		domain: `fleet-${index}.example.test`,
		email: `manager@fleet-${index}.example.test`,
		industry: "transport",
		fleetBand: "unknown",
		fleetEvidence: "Not verified",
		fit: "Operates delivery vehicles in Western Australia",
		sourceUrl: `https://fleet-${index}.example.test`,
		sourceQuote: "We operate delivery vehicles across Perth.",
		waQuote: "Perth",
		checkedAt: now.toISOString(),
		verified: true,
	});
}

const consent = {
	kind: "express" as const,
	evidence: "Explicit request for information about Geotab fleet tracking.",
	source: "test-fixture-request",
	roleRelevant: true as const,
	noRestriction: true as const,
};
const checks = {
	spf: true as const,
	dkim: true as const,
	dmarc: true as const,
	controlledDelivery: true as const,
	replyStop: true as const,
	optOutStop: true as const,
	logging: true as const,
	evidence: "Controlled test fixtures pass without any external email.",
};

beforeAll(async () => {
	if (
		(await db.outreachCampaign.count()) ||
		(await db.user.findFirst({ where: { email: OUTREACH.sender } }))
	)
		throw new Error("Requires an empty isolated outreach test workspace.");
	await db.user.create({
		data: {
			id: userId,
			name: "Outreach Test",
			email: OUTREACH.sender,
			emailVerified: true,
		},
	});
	await db.company.create({
		data: { id: companyId, name: "Outreach Test Company", ownerId: userId },
	});
	owned = true;
});

beforeEach(async () => {
	setSystemTime(now);
	process.env.VERCEL_ENV = "production";
	await service.initialize(userId);
	await db.mailboxSync.upsert({
		where: { userId_source: { userId, source: "calendar" } },
		create: { userId, source: "calendar", lastSyncedAt: now },
		update: { lastSyncedAt: now },
	});
	await db.mailboxSync.upsert({
		where: { userId_source: { userId, source: "gmail" } },
		create: { userId, source: "gmail", lastSyncedAt: now },
		update: {},
	});
	const token = spyOn(tokens, "accessTokenFor").mockResolvedValue({
		outcome: "ok",
		accessToken: "test-token",
	});
	const scopes = spyOn(tokens, "grantedScopes").mockResolvedValue(
		new Set(["https://www.googleapis.com/auth/gmail.send"]),
	);
	const profile = spyOn(gmail, "profile").mockResolvedValue(OUTREACH.sender);
	const search = spyOn(gmail, "search").mockResolvedValue([]);
	const thread = spyOn(gmail, "threadIds").mockResolvedValue([]);
	const message = spyOn(gmail, "message").mockImplementation(
		async (_token, id) => {
			const message = messages.get(id);
			if (!message) throw new Error("Unknown mocked Gmail message");
			return message;
		},
	);
	messages.clear();
	sent.mockClear();
	sent.mockImplementation(async (_token, message) => accept(message));
	const send = spyOn(gmail, "send").mockImplementation(sent);
	const context = spyOn(writer, "context").mockResolvedValue({
		ourAddresses: new Set([OUTREACH.sender]),
		ourDomains: new Set(),
		suppressedDomains: new Set(),
		suppressedEmails: new Set(),
	});
	const resolve = spyOn(match, "resolve").mockResolvedValue({
		companyId,
		contactId: null,
		external: [],
	});
	const network = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("External network is forbidden in outreach integration tests"),
	);
	for (const handle of [
		token,
		scopes,
		profile,
		search,
		thread,
		message,
		send,
		context,
		resolve,
		network,
	])
		restores.push(() => handle.mockRestore());
});

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	setSystemTime();
	delete process.env.VERCEL_ENV;
	if (!owned) return;
	await db.outreachDelivery.deleteMany({
		where: { prospect: { campaignId: OUTREACH.id } },
	});
	await db.outreachProspect.deleteMany({ where: { campaignId: OUTREACH.id } });
	await db.outreachReport.deleteMany({ where: { campaignId: OUTREACH.id } });
	await db.outreachCampaign.deleteMany({
		where: { id: OUTREACH.id, ownerId: userId },
	});
	await db.outreachSuppression.deleteMany({
		where: { email: { endsWith: ".example.test" }, reason: "SUPPRESSED" },
	});
	await db.outreachBudget.deleteMany({ where: { id: budgetId } });
	await db.emailThread.deleteMany({
		where: { messages: { some: { syncedByUserId: userId } } },
	});
});

afterAll(async () => {
	if (owned) {
		await db.company.delete({ where: { id: companyId } });
		await db.user.delete({ where: { id: userId } });
	}
	await db.$disconnect();
});

async function pilot(size = 12) {
	for (let index = 1; index <= size; index += 1) {
		const source = evidence(index);
		const prospect = await db.outreachProspect.create({
			data: {
				campaignId: OUTREACH.id,
				domain: source.domain,
				email: source.email,
				evidence: source,
				nextDueAt: now,
			},
		});
		await service.qualify(userId, { id: prospect.id, consent });
	}
	await service.action(userId, {
		action: "approve",
		hash: campaignHash(DEFAULT_TEMPLATES),
	});
	await service.readiness(userId, checks);
	await service.action(userId, { action: "start-pilot" });
}

describe("outreach durable workflow", () => {
	test("verified delivered identities preserve case in both follow-ups and CRM threading", async () => {
		await pilot();
		sent.mockImplementation(async (_token, message) => accept(message, true));
		await dispatcher.run();
		const initial = await db.outreachDelivery.findFirstOrThrow();
		expect(initial.observedRfcMessageId).toStartWith("CAPx-");
		expect(initial.observedRfcMessageId).not.toBe(initial.rfcMessageId);
		expect(initial.loggedAt).not.toBeNull();
		await db.outreachProspect.updateMany({
			where: { id: { not: initial.prospectId }, manual: false },
			data: { status: "HELD" },
		});
		await db.outreachDelivery.update({
			where: { id: initial.id },
			data: { observedRfcMessageId: null },
		});
		for (const stage of [1, 2]) {
			const prospect = await db.outreachProspect.findUniqueOrThrow({
				where: { id: initial.prospectId },
			});
			setSystemTime(prospect.nextDueAt);
			await db.mailboxSync.update({
				where: { userId_source: { userId, source: "calendar" } },
				data: { lastSyncedAt: prospect.nextDueAt },
			});
			await dispatcher.run();
			const request = sent.mock.calls[stage]?.[1];
			expect(request?.rootId).toBe(initial.observedRfcMessageId ?? undefined);
			expect(request?.threadId).toBe(initial.gmailThreadId ?? undefined);
		}
		expect(sent).toHaveBeenCalledTimes(3);
		expect(
			(
				await db.outreachDelivery.findUniqueOrThrow({
					where: { id: initial.id },
				})
			).rfcMessageId,
		).toBe(initial.rfcMessageId);
		const logged = await db.emailMessage.findMany({
			where: { syncedByUserId: userId },
		});
		expect(logged).toHaveLength(3);
		expect(new Set(logged.map((message) => message.threadId)).size).toBe(1);
	});
	test("a conflicting delivered identity holds existing sends and follow-ups", async () => {
		await pilot();
		await dispatcher.run();
		const initial = await db.outreachDelivery.findFirstOrThrow();
		const message = messages.get(initial.gmailMessageId ?? "");
		if (!message?.payload?.headers)
			throw new Error("Missing mocked sent message");
		message.payload.headers = message.payload.headers.map((entry) =>
			entry.name === "Message-ID"
				? { ...entry, value: "<changed@mail.gmail.com>" }
				: entry,
		);
		await db.outreachProspect.updateMany({
			where: { id: { not: initial.prospectId }, manual: false },
			data: { status: "HELD" },
		});
		const prospect = await db.outreachProspect.findUniqueOrThrow({
			where: { id: initial.prospectId },
		});
		setSystemTime(prospect.nextDueAt);
		await db.mailboxSync.update({
			where: { userId_source: { userId, source: "calendar" } },
			data: { lastSyncedAt: prospect.nextDueAt },
		});
		await dispatcher.run();
		await dispatcher.run();
		expect(sent).toHaveBeenCalledTimes(1);
		expect((await service.status(userId)).lastError).toContain(
			"identity changed",
		);
		expect(await db.outreachDelivery.count()).toBe(1);
	});
	test("default state cannot send", async () => {
		await dispatcher.run();
		expect(sent).not.toHaveBeenCalled();
		expect((await service.status(userId)).approved).toBe(false);
	});
	test("first two are permanent manual exclusions; concurrent ticks send once", async () => {
		await pilot();
		await Promise.all([dispatcher.run(), dispatcher.run()]);
		expect(sent).toHaveBeenCalledTimes(1);
		expect(
			await db.outreachProspect.count({
				where: { manual: true, status: "MANUAL" },
			}),
		).toBe(2);
		expect(
			await db.outreachDelivery.count({
				where: { prospect: { manual: true } },
			}),
		).toBe(0);
		expect(
			await db.outreachDelivery.count({
				where: { status: "SENT", loggedAt: { not: null } },
			}),
		).toBe(1);
	});
	test("daily initial cap is enforced after restarts", async () => {
		await pilot(15);
		for (let index = 0; index < 12; index += 1) await dispatcher.run();
		expect(sent).toHaveBeenCalledTimes(10);
		expect(await db.outreachDelivery.count({ where: { stage: 0 } })).toBe(10);
	});
	test("missing CRM match holds logging and retries without sending again", async () => {
		await pilot();
		spyOn(match, "resolve").mockResolvedValue({
			companyId: null,
			contactId: null,
			external: [],
		});
		await dispatcher.run();
		const delivery = await db.outreachDelivery.findFirstOrThrow();
		expect(delivery.status).toBe("SENT");
		expect(delivery.loggedAt).toBeNull();
		expect(
			await db.emailMessage.count({ where: { syncedByUserId: userId } }),
		).toBe(0);
		expect((await service.status(userId)).lastError).toContain(
			"no CRM message",
		);
		await service.action(userId, { action: "pause" });
		spyOn(match, "resolve").mockResolvedValue({
			companyId,
			contactId: null,
			external: [],
		});
		await dispatcher.run();
		expect(sent).toHaveBeenCalledTimes(1);
		expect(
			(
				await db.outreachDelivery.findUniqueOrThrow({
					where: { id: delivery.id },
				})
			).loggedAt,
		).not.toBeNull();
		expect(
			await db.emailMessage.count({ where: { syncedByUserId: userId } }),
		).toBe(1);
	});
	test("an existing logged CRM message reconciles without a duplicate send", async () => {
		await pilot();
		await dispatcher.run();
		const delivery = await db.outreachDelivery.findFirstOrThrow();
		await db.outreachDelivery.update({
			where: { id: delivery.id },
			data: { loggedAt: null },
		});
		await service.action(userId, { action: "pause" });
		await dispatcher.run();
		expect(sent).toHaveBeenCalledTimes(1);
		expect(
			(
				await db.outreachDelivery.findUniqueOrThrow({
					where: { id: delivery.id },
				})
			).loggedAt,
		).not.toBeNull();
		expect(
			await db.emailMessage.count({ where: { syncedByUserId: userId } }),
		).toBe(1);
	});
	test("ambiguous sending does not retry", async () => {
		await pilot();
		sent.mockRejectedValue(
			new Error("Connection closed after Gmail accepted request"),
		);
		await dispatcher.run();
		await dispatcher.run();
		expect(sent).toHaveBeenCalledTimes(1);
		expect(
			await db.outreachDelivery.count({ where: { status: "UNKNOWN" } }),
		).toBe(1);
		expect((await service.status(userId)).lastError).toContain("uncertain");
	});
	test("reply in Gmail thread pauses even when search misses it", async () => {
		await pilot();
		await dispatcher.run();
		spyOn(gmail, "threadIds").mockResolvedValue([{ id: "reply-id" }]);
		spyOn(gmail, "message").mockResolvedValue({
			id: "reply-id",
			labelIds: ["INBOX"],
			payload: {
				headers: [{ name: "from", value: "colleague@fleet-3.example.test" }],
				body: {
					data: Buffer.from("Please discuss our fleet needs").toString(
						"base64url",
					),
				},
			},
		});
		await dispatcher.run();
		expect(
			await db.outreachProspect.count({ where: { status: "REPLIED" } }),
		).toBe(1);
	});
	test("unsubscribe persists across campaign pauses", async () => {
		await pilot();
		spyOn(gmail, "search").mockResolvedValue([
			{ id: "reply-id", threadId: "thread-id" },
		]);
		spyOn(gmail, "message").mockResolvedValue({
			id: "reply-id",
			labelIds: ["INBOX"],
			payload: {
				headers: [{ name: "from", value: "manager@fleet-3.example.test" }],
				body: { data: Buffer.from("Unsubscribe me").toString("base64url") },
			},
		});
		await dispatcher.run();
		expect(sent).not.toHaveBeenCalled();
		expect(
			await db.outreachSuppression.count({ where: { reason: "SUPPRESSED" } }),
		).toBe(1);
	});
	test("stale calendar blocks sending", async () => {
		await pilot();
		await db.mailboxSync.update({
			where: { userId_source: { userId, source: "calendar" } },
			data: { lastSyncedAt: new Date("2026-09-01") },
		});
		await dispatcher.run();
		expect(sent).not.toHaveBeenCalled();
		expect((await service.status(userId)).lastError).toContain(
			"Calendar sync is stale",
		);
	});
	test("template changes revoke approval and launch checks", async () => {
		await pilot();
		await service.update(userId, {
			...DEFAULT_TEMPLATES,
			subject: "Updated fleet question",
		});
		const status = await service.status(userId);
		expect(status.approved).toBe(false);
		expect(status.ready).toBe(false);
		await dispatcher.run();
		expect(sent).not.toHaveBeenCalled();
	});
	test("budget reservations are atomic under concurrent workers", async () => {
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				reserveOutreachBudget(db, budgetId, 1_000_000, 10_000_000),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(10);
		expect(
			(await db.outreachBudget.findUniqueOrThrow({ where: { id: budgetId } }))
				.reservedMicroUsd,
		).toBe(10_000_000);
	});
});
