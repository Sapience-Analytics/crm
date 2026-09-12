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
import { OUTREACH } from "@crm/validation/outreach";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { GmailClient, type GmailMessage } from "../src/google/gmail.client";
import { GmailSyncService } from "../src/google/gmail-sync.service";
import { MailboxApiClient } from "../src/mailbox/mailbox-api.client";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { SyncStateService } from "../src/mailbox/sync-state.service";
import { ThreadWriterService } from "../src/mailbox/thread-writer.service";
import { OutreachService } from "../src/outreach/outreach.service";
import { OutreachGmail } from "../src/outreach/outreach-gmail";
import { OutreachLaunchTestsService } from "../src/outreach/outreach-launch-tests.service";

const userId = `launch-test-owner-${crypto.randomUUID()}`;
const outsiderId = `launch-test-outsider-${crypto.randomUUID()}`;
const recipient = `controlled-${crypto.randomUUID()}@gmail.com`;
const now = new Date("2026-09-14T03:00:00.000Z");
const tokens = new MailboxTokenService(db);
const gmail = new OutreachGmail(new GmailClient(new MailboxApiClient()));
const match = new MailboxMatchService(
	db,
	Object.create(CompanyDirectoryService.prototype),
	Object.create(AgentTriggerService.prototype),
	Object.create(EnrichmentLogService.prototype),
);
const writer = new ThreadWriterService(db, match, new ActivityStampService(db));
const parser = new GmailSyncService(
	db,
	new GmailClient(new MailboxApiClient()),
	tokens,
	new SyncStateService(db),
	writer,
);
const outreach = new OutreachService(db, tokens);
const service = new OutreachLaunchTestsService(
	db,
	outreach,
	tokens,
	gmail,
	parser,
	writer,
);
const messages = new Map<string, GmailMessage>();
const restores: (() => void)[] = [];
const sender = mock(
	async (_token: string, message: Parameters<OutreachGmail["send"]>[1]) =>
		accept(message),
);
let owned = false;

function input() {
	return {
		batchId: crypto.randomUUID(),
		recipientEmail: recipient,
		ownsMailbox: true as const,
		acceptsTwoEmails: true as const,
	};
}

async function failureOf(promise: Promise<unknown>) {
	return promise.then(
		() => "",
		(error: Error) => error.message,
	);
}
function accept(message: Parameters<OutreachGmail["send"]>[1]) {
	const id = `sent-${crypto.randomUUID()}`;
	const threadId = `thread-${crypto.randomUUID()}`;
	messages.set(id, {
		id,
		threadId,
		internalDate: String(now.getTime()),
		labelIds: ["SENT"],
		payload: {
			mimeType: "text/plain",
			headers: [
				{ name: "Message-ID", value: `<${message.rfcId}>` },
				{ name: "From", value: message.from },
				{ name: "To", value: message.to },
				{ name: "Subject", value: message.subject },
			],
			body: { data: Buffer.from(message.body).toString("base64url") },
		},
	});
	return { id, threadId };
}
function addReply(
	row: { rfcMessageId: string; gmailThreadId: string | null },
	body: string,
) {
	const id = `reply-${crypto.randomUUID()}`;
	messages.set(id, {
		id,
		threadId: row.gmailThreadId ?? "",
		internalDate: String(now.getTime() + 1000),
		labelIds: ["INBOX"],
		payload: {
			mimeType: "text/plain",
			headers: [
				{ name: "Message-ID", value: `<${id}@gmail.com>` },
				{ name: "References", value: `<${row.rfcMessageId}>` },
				{ name: "From", value: recipient },
				{ name: "To", value: OUTREACH.sender },
			],
			body: { data: Buffer.from(body).toString("base64url") },
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
				id: userId,
				name: "Test Owner",
				email: OUTREACH.sender,
				emailVerified: true,
			},
			{
				id: outsiderId,
				name: "Test Member",
				email: `${outsiderId}@example.test`,
				emailVerified: true,
			},
		],
	});
	owned = true;
});

beforeEach(async () => {
	setSystemTime(now);
	process.env.VERCEL_ENV = "production";
	await outreach.initialize(userId);
	await db.mailboxSync.upsert({
		where: { userId_source: { userId, source: "gmail" } },
		create: { userId, source: "gmail", autoCreate: false },
		update: {},
	});
	messages.clear();
	sender.mockClear();
	sender.mockImplementation(async (_token, message) => accept(message));
	const handles = [
		spyOn(tokens, "accessTokenFor").mockResolvedValue({
			outcome: "ok",
			accessToken: "local-test-token",
		}),
		spyOn(tokens, "grantedScopes").mockResolvedValue(
			new Set(["https://www.googleapis.com/auth/gmail.send"]),
		),
		spyOn(gmail, "profile").mockResolvedValue(OUTREACH.sender),
		spyOn(gmail, "message").mockImplementation(async (_token, id) => {
			const message = messages.get(id);
			if (!message) throw new Error("Unknown mocked Gmail message");
			return message;
		}),
		spyOn(gmail, "search").mockImplementation(async (_token, query) => {
			const rfcId = query.split("rfc822msgid:")[1];
			return [...messages.entries()]
				.filter(
					([, message]) =>
						message.labelIds?.includes("SENT") &&
						message.payload?.headers?.some(
							(entry) =>
								entry.name === "Message-ID" && entry.value === `<${rfcId}>`,
						),
				)
				.map(([id, message]) => ({
					id,
					threadId: message.threadId ?? "",
				}));
		}),
		spyOn(gmail, "threadIds").mockImplementation(async (_token, threadId) =>
			[...messages.entries()]
				.filter(([, message]) => message.threadId === threadId)
				.map(([id]) => ({ id })),
		),
		spyOn(gmail, "send").mockImplementation(sender),
		spyOn(writer, "context").mockResolvedValue({
			ourAddresses: new Set([OUTREACH.sender]),
			ourDomains: new Set(["sapienceanalytics.com.au"]),
			suppressedDomains: new Set(),
			suppressedEmails: new Set(),
		}),
		spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("External network is forbidden in controlled outreach tests"),
		),
	];
	for (const handle of handles) restores.push(() => handle.mockRestore());
});

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	setSystemTime();
	delete process.env.VERCEL_ENV;
	if (!owned) return;
	await db.emailThread.deleteMany({
		where: { messages: { some: { syncedByUserId: userId } } },
	});
	await db.outreachLaunchTest.deleteMany({ where: { ownerId: userId } });
	await db.contact.deleteMany({ where: { ownerId: userId, email: recipient } });
	await db.outreachCampaign.deleteMany({
		where: { id: OUTREACH.id, ownerId: userId },
	});
});
afterAll(async () => {
	if (owned)
		await db.user.deleteMany({ where: { id: { in: [userId, outsiderId] } } });
	await db.$disconnect();
});

describe("isolated controlled Gmail tests", () => {
	test("only the sender can manage tests; preview and self-send are refused", async () => {
		expect(await failureOf(service.list(outsiderId))).toContain(
			"Only the campaign sender",
		);
		expect(await failureOf(service.start(outsiderId, input()))).toContain(
			"Only the campaign sender",
		);
		process.env.VERCEL_ENV = "preview";
		expect(await failureOf(service.start(userId, input()))).toContain(
			"production API",
		);
		process.env.VERCEL_ENV = "production";
		expect(
			await failureOf(
				service.start(userId, { ...input(), recipientEmail: OUTREACH.sender }),
			),
		).toContain("Self-send");
		expect(sender).not.toHaveBeenCalled();
	});
	test("two fixed emails use isolated contact records and preserve pilot slots and approval", async () => {
		const approved = await outreach.status(userId);
		await outreach.action(userId, { action: "approve", hash: approved.hash });
		const request = input();
		await Promise.all([
			service.start(userId, request),
			service.start(userId, request),
		]);
		expect(sender).toHaveBeenCalledTimes(2);
		const tests = await service.list(userId);
		expect(tests.rows).toHaveLength(2);
		expect(
			tests.rows.every((row) => row.loggedAt !== null && row.status === "SENT"),
		).toBe(true);
		expect(await db.outreachProspect.count()).toBe(0);
		expect(await db.outreachDelivery.count()).toBe(0);
		expect(await db.outreachSuppression.count()).toBe(0);
		expect(
			await db.emailMessage.count({ where: { syncedByUserId: userId } }),
		).toBe(2);
		const after = await outreach.status(userId);
		expect(after.status).toBe("PAUSED");
		expect(after.approved).toBe(true);
		expect(after.ready).toBe(false);
		expect(
			(await db.contact.findFirstOrThrow({ where: { email: recipient } }))
				.enrichmentStatus,
		).toBe("SKIPPED");
		const failure = await service.start(userId, input()).then(
			() => null,
			(error: Error) => error.message,
		);
		expect(failure).toContain("daily limit");
	});
	test("unknown send reconciles after restart and never resends", async () => {
		const request = input();
		sender.mockImplementationOnce(async (_token, message) => {
			accept(message);
			throw new Error("Connection closed after acceptance");
		});
		await service.start(userId, request);
		const unknown = await db.outreachLaunchTest.findFirstOrThrow({
			where: { status: "UNKNOWN", ownerId: userId },
		});
		const restarted = new OutreachLaunchTestsService(
			db,
			outreach,
			tokens,
			gmail,
			parser,
			writer,
		);
		await restarted.start(userId, request);
		await restarted.check(userId, unknown.id);
		await restarted.check(userId, unknown.id);
		expect(sender).toHaveBeenCalledTimes(2);
		const reconciled = await db.outreachLaunchTest.findUniqueOrThrow({
			where: { id: unknown.id },
		});
		expect(reconciled.rfcMessageId).toBe(unknown.rfcMessageId);
		expect(reconciled.status).toBe("SENT");
		expect(reconciled.loggedAt).not.toBeNull();
		expect(
			await db.emailMessage.count({ where: { syncedByUserId: userId } }),
		).toBe(2);
	});
	test("unresolved delivery never retries and prevents another test batch", async () => {
		sender.mockImplementationOnce(async () => {
			throw new Error("Unknown send outcome");
		});
		await service.start(userId, input());
		const row = await db.outreachLaunchTest.findFirstOrThrow({
			where: { status: "UNKNOWN", ownerId: userId },
		});
		await service.check(userId, row.id);
		await service.check(userId, row.id);
		expect(await failureOf(service.start(userId, input()))).toContain(
			"Reconcile uncertain",
		);
		expect(sender).toHaveBeenCalledTimes(2);
		expect(
			(await db.outreachLaunchTest.findUniqueOrThrow({ where: { id: row.id } }))
				.status,
		).toBe("UNKNOWN");
	});
	test("real inbound messages share classification and log once without campaign suppression", async () => {
		await service.start(userId, input());
		const reply = await db.outreachLaunchTest.findFirstOrThrow({
			where: { ownerId: userId, kind: "reply" },
		});
		const optout = await db.outreachLaunchTest.findFirstOrThrow({
			where: { ownerId: userId, kind: "optout" },
		});
		addReply(
			reply,
			"Test reply received.\n\nOn Monday, Danny wrote:\n> Unsubscribe this test.",
		);
		addReply(optout, "Unsubscribe this test.");
		for (const row of [reply, optout]) {
			await service.check(userId, row.id);
			await service.check(userId, row.id);
		}
		expect(
			(
				await db.outreachLaunchTest.findUniqueOrThrow({
					where: { id: reply.id },
				})
			).responseStatus,
		).toBe("REPLIED");
		expect(
			(
				await db.outreachLaunchTest.findUniqueOrThrow({
					where: { id: optout.id },
				})
			).responseStatus,
		).toBe("SUPPRESSED");
		expect(
			await db.outreachLaunchTest.count({
				where: { responseLoggedAt: { not: null } },
			}),
		).toBe(2);
		expect(
			await db.emailMessage.count({ where: { syncedByUserId: userId } }),
		).toBe(4);
		expect(await db.outreachSuppression.count()).toBe(0);
		expect(sender).toHaveBeenCalledTimes(2);
		expect((await outreach.status(userId)).ready).toBe(false);
	});
	test("archived real contacts cannot receive isolated test logs", async () => {
		await db.contact.create({
			data: {
				firstName: "Existing real contact",
				email: recipient,
				ownerId: userId,
				archivedAt: now,
			},
		});
		expect(await failureOf(service.start(userId, input()))).toContain(
			"existing CRM contact",
		);
		expect(sender).not.toHaveBeenCalled();
		expect(await db.outreachLaunchTest.count()).toBe(0);
	});
});
