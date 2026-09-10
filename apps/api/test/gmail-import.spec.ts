import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	type Db,
	type GmailImportModel,
	GoogleSyncStatus,
	type MailboxSyncModel,
} from "@crm/db";
import { z } from "zod";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { GmailClient } from "../src/google/gmail.client";
import {
	GmailImportService,
	importStart,
} from "../src/google/gmail-import.service";
import { GmailSyncService } from "../src/google/gmail-sync.service";
import { MailboxApiClient } from "../src/mailbox/mailbox-api.client";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { SyncStateService } from "../src/mailbox/sync-state.service";
import { ThreadWriterService } from "../src/mailbox/thread-writer.service";

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});
const restores: (() => void)[] = [];

function fixture() {
	const mailbox: MailboxSyncModel = {
		id: "mailbox",
		userId: "user",
		source: "gmail",
		status: GoogleSyncStatus.RUNNING,
		cursor: "live-cursor",
		lastSyncedAt: null,
		lastError: null,
		retryAfter: null,
		autoCreate: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	const job: GmailImportModel & { mailbox: MailboxSyncModel } = {
		id: "job",
		mailboxId: mailbox.id,
		mailbox,
		after: new Date("2025-09-10T00:00:00Z"),
		before: new Date("2026-09-10T00:00:00Z"),
		phase: "sent",
		pageToken: null,
		pendingIds: [],
		pageLoaded: false,
		reviewed: 0,
		imported: 0,
		skipped: 0,
		lastError: null,
		retryAfter: null,
		leaseToken: null,
		leaseUntil: null,
		completedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	const changes = z.object({
		phase: z.string().optional(),
		pendingIds: z.array(z.string()).optional(),
		pageToken: z.string().nullable().optional(),
		pageLoaded: z.boolean().optional(),
		completedAt: z.date().optional(),
		lastError: z.string().nullable().optional(),
		retryAfter: z.date().nullable().optional(),
		reviewed: z.object({ increment: z.number() }).optional(),
		imported: z.object({ increment: z.number() }).optional(),
		skipped: z.object({ increment: z.number() }).optional(),
	});
	const fake = {
		gmailImport: {
			findFirst: async () => structuredClone(job),
			updateMany: async (_args: { data: z.input<typeof changes> }) => ({
				count: 0,
			}),
		},
		mailboxSync: { update: async () => mailbox },
	};
	const db = fake as unknown as Db;
	const find = spyOn(fake.gmailImport, "findFirst");
	const update = spyOn(fake.gmailImport, "updateMany").mockImplementation(
		async ({ data }) => {
			const { reviewed, imported, skipped, ...fields } = changes.parse(data);
			Object.assign(job, fields);
			job.reviewed += reviewed?.increment ?? 0;
			job.imported += imported?.increment ?? 0;
			job.skipped += skipped?.increment ?? 0;
			return { count: 1 };
		},
	);
	const cursor = spyOn(fake.mailboxSync, "update").mockImplementation(() => {
		throw new Error("Live cursor must not change");
	});
	const gmail = new GmailClient(new MailboxApiClient());
	const tokens = Object.create(
		MailboxTokenService.prototype,
	) as MailboxTokenService;
	const token = spyOn(tokens, "accessTokenFor").mockResolvedValue({
		outcome: "ok",
		accessToken: "test-only",
	});
	const profile = spyOn(gmail, "profile").mockResolvedValue({
		outcome: "ok",
		data: { emailAddress: "owner@example.test" },
	});
	const threads = new ThreadWriterService(
		db,
		Object.create(MailboxMatchService.prototype),
		new ActivityStampService(db),
	);
	const context = spyOn(threads, "context").mockResolvedValue({
		ourAddresses: new Set(),
		ourDomains: new Set(),
		suppressedDomains: new Set(),
		suppressedEmails: new Set(),
	});
	const stored = new Set<string>();
	const store = spyOn(threads, "store").mockImplementation(
		async (_row, _options, message) => {
			if (stored.has(message.rfcMessageId)) return false;
			stored.add(message.rfcMessageId);
			return true;
		},
	);
	const message = spyOn(gmail, "getMessage").mockImplementation(
		async (_token, id) => ({
			outcome: "ok",
			data: {
				id,
				internalDate: String(new Date("2026-01-01").getTime()),
				payload: {
					headers: [
						{ name: "Message-ID", value: `<${id}@test>` },
						{ name: "From", value: "owner@example.test" },
						{ name: "To", value: "contact@customer.test" },
					],
				},
			},
		}),
	);
	const list = spyOn(gmail, "listMessages").mockImplementation(
		async (_token, options) => ({
			outcome: "ok",
			data: { messages: [{ id: options.sentOnly ? "sent" : "received" }] },
		}),
	);
	for (const spy of [
		find,
		update,
		cursor,
		token,
		profile,
		context,
		store,
		message,
		list,
	])
		restores.push(() => spy.mockRestore());
	const parser = new GmailSyncService(
		db,
		gmail,
		tokens,
		new SyncStateService(db),
		threads,
	);
	return {
		job,
		cursor,
		store,
		stored,
		message,
		list,
		update,
		service: new GmailImportService(db, gmail, tokens, parser, threads),
	};
}

describe("Historical Gmail import", () => {
	it("uses twelve calendar months and clamps leap days", () => {
		expect(importStart(new Date("2024-02-29T10:00:00Z")).toISOString()).toBe(
			"2023-02-28T10:00:00.000Z",
		);
	});
	it("imports sent mail before received mail without changing the live cursor", async () => {
		const f = fixture();
		await f.service.runBatch("user");
		expect(f.list.mock.calls.map((call) => call[1].sentOnly)).toEqual([
			true,
			false,
		]);
		expect(f.job.phase).toBe("complete");
		expect(f.job.imported).toBe(2);
		expect(f.cursor).not.toHaveBeenCalled();
	});
	it("keeps pending emails and page progress after a rate limit", async () => {
		const f = fixture();
		f.message.mockResolvedValueOnce({
			outcome: "rate-limited",
			reason: "quota",
			retryAfterMs: 90_000,
		});
		await f.service.runBatch("user");
		expect(f.job.pendingIds).toEqual(["sent"]);
		expect(f.job.reviewed).toBe(0);
		expect(f.job.retryAfter?.getTime()).toBeGreaterThan(Date.now() + 80_000);
		await f.service.runBatch("user");
		expect(f.job.phase).toBe("complete");
		expect(f.job.imported).toBe(2);
	});
	it("replays an already stored message without duplicating it", async () => {
		const f = fixture();
		f.stored.add("sent@test");
		await f.service.runBatch("user");
		expect(f.job.imported).toBe(1);
		expect(f.job.skipped).toBe(1);
	});
	it("does no work when another worker holds the lease", async () => {
		const f = fixture();
		f.update.mockResolvedValueOnce({ count: 0 });
		await f.service.runBatch("user");
		expect(f.list).not.toHaveBeenCalled();
		expect(f.store).not.toHaveBeenCalled();
	});
});
