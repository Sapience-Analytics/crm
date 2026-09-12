import type { Db, MailboxSyncModel } from "@crm/db";
import { stopReason } from "@crm/validation/outreach";
import type { GmailMessage } from "../google/gmail.client";
import { header, plainTextBody } from "../google/gmail-mime";
import { stripQuotedHistory } from "../mailbox/message-text";
import type {
	IncomingMessage,
	ThreadWriterService,
} from "../mailbox/thread-writer.service";

export function classifyOutreachMessage(message: GmailMessage) {
	const body = stripQuotedHistory(plainTextBody(message.payload));
	const from = header(message.payload?.headers, "from") ?? "";
	const subject = header(message.payload?.headers, "subject") ?? "";
	return { status: stopReason(from, `${subject}\n${body}`), body };
}

export async function storeOutreachMessage(
	db: Db,
	writer: ThreadWriterService,
	mailbox: MailboxSyncModel,
	sender: string,
	parsed: IncomingMessage,
	knownContactId?: string,
) {
	await writer.store(
		mailbox,
		{ mailbox: sender, origin: "gmail" },
		parsed,
		await writer.context(),
		knownContactId,
	);
	const logged = await db.emailMessage.findUnique({
		where: { rfcMessageId: parsed.rfcMessageId },
		select: {
			id: true,
			thread: { select: { activity: { select: { id: true } } } },
		},
	});
	if (!logged?.thread.activity)
		throw new Error(
			"Sent email has no CRM message and activity. Logging will retry.",
		);
	return logged.id;
}
