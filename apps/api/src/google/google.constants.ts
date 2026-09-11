export {
	CALENDAR_SCOPE,
	GMAIL_SCOPE,
	GOOGLE_PROVIDER_ID,
	GOOGLE_SYNC_SOURCES,
	type GoogleSyncSource,
	SCOPE_FOR_SOURCE,
	SYNC_SCOPES,
} from "../mailbox/mailbox.constants";

export const GMAIL_IMPORT = {
	months: 12,
	batchMs: 20_000,
	leaseMs: 300_000,
	pageSize: 100,
	retryMs: 60_000,
} as const;
