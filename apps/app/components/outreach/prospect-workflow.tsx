import { Alert, AlertDescription, AlertTitle } from "@crm/ui/components/alert";
import type { RouterOutputs } from "@/lib/trpc/types";

type Prospect = Pick<
	RouterOutputs["outreach"]["prospects"]["rows"][number],
	| "eligibilityError"
	| "status"
	| "referredFrom"
	| "email"
	| "referrals"
	| "stoppedAt"
	| "deliveries"
	| "replyText"
>;

function referralStatus(status: string) {
	switch (status) {
		case "PENDING":
			return "Queued for verification";
		case "PROCESSING":
			return "Verification in progress";
		case "HELD":
			return "Held for review";
		case "IGNORED":
			return "No eligible referral";
		case "CREATED":
			return "New prospect created";
		default:
			return status;
	}
}

function referralReason(reason: string) {
	switch (reason) {
		case "no-explicit-referral":
			return "The reply does not contain an explicit referral.";
		case "multiple-recipients":
			return "The reply names multiple recipients. Review the correct contact.";
		case "uncertain-request":
			return "The referral request is unclear. Review the reply before proceeding.";
		default:
			return reason;
	}
}

export function ProspectWorkflow({ prospect }: { prospect: Prospect }) {
	return (
		<div className="flex flex-col gap-4">
			{prospect.eligibilityError && (
				<Alert>
					<AlertTitle>Contact eligibility needs review</AlertTitle>
					<AlertDescription>{prospect.eligibilityError}</AlertDescription>
				</Alert>
			)}
			{prospect.status === "HELD" && !prospect.eligibilityError && (
				<p>
					This prospect stays held. Review its company source and contact
					eligibility before release.
				</p>
			)}
			{prospect.referredFrom && (
				<Alert role="status">
					<AlertTitle>Same-company referral</AlertTitle>
					<AlertDescription>
						<p>
							{prospect.referredFrom.company}: {prospect.referredFrom.email} →{" "}
							{prospect.email}
						</p>
						<p>
							Original sequence: {prospect.referredFrom.status}.
							{prospect.referredFrom.stoppedAt &&
								` Stopped at ${prospect.referredFrom.stoppedAt}.`}
						</p>
						<p>
							This contact cannot start another automatic referral sequence.
						</p>
					</AlertDescription>
				</Alert>
			)}
			{prospect.referrals.map((referral) => (
				<Alert key={referral.id} role="status">
					<AlertTitle>Referral: {referralStatus(referral.status)}</AlertTitle>
					<AlertDescription>
						<p>
							From {prospect.email ?? "the original contact"} to{" "}
							{referral.recipientName ? `${referral.recipientName} · ` : ""}
							{referral.recipientEmail ?? "no confirmed recipient"}.
						</p>
						<p>
							Original sequence: {prospect.status}.
							{prospect.stoppedAt && ` Stopped at ${prospect.stoppedAt}.`}
						</p>
						{referral.reason && <p>{referralReason(referral.reason)}</p>}
					</AlertDescription>
				</Alert>
			))}
			{prospect.deliveries.map((delivery) => (
				<Alert key={delivery.id} role="status">
					<AlertTitle>
						{delivery.stage === 0
							? "Initial email"
							: `Follow-up ${delivery.stage}`}
						:{" "}
						{delivery.status === "UNKNOWN"
							? "delivery unconfirmed"
							: "send in progress"}
					</AlertTitle>
					<AlertDescription>
						<p>
							Wait for mailbox reconciliation. Do not resend this message
							manually.
						</p>
						{delivery.error && <p>{delivery.error}</p>}
					</AlertDescription>
				</Alert>
			))}
			{prospect.status === "REPLIED" && (
				<p>
					Review the conversation and send your response. The campaign does not
					send customer conversation replies automatically.
				</p>
			)}
			{prospect.replyText && (
				<details>
					<summary>Received reply</summary>
					<pre className="whitespace-pre-wrap">{prospect.replyText}</pre>
				</details>
			)}
		</div>
	);
}
