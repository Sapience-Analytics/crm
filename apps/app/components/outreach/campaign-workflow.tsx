import { Alert, AlertDescription, AlertTitle } from "@crm/ui/components/alert";
import type { RouterOutputs } from "@/lib/trpc/types";

type Campaign = RouterOutputs["outreach"]["status"];

export function CampaignWorkflow({
	campaign,
}: {
	campaign: Pick<Campaign, "approved" | "deliveries">;
}) {
	return (
		<div className="flex flex-col gap-4">
			<p>
				Cloud research verifies WA companies and contacts. Automatic eligibility
				checks hold uncertain prospects for review.
			</p>
			<p>
				AI personalises the initial email and both follow-ups from verified
				facts. After approval, eligible prospects proceed automatically.
			</p>
			<p>
				An explicit referral can start one new sequence within the same company.
				The system verifies the new contact first. Further referrals stay held.
			</p>
			<p>
				Replies stop the original sequence. Customer conversations receive
				drafts for you to review and send.
			</p>
			<p>
				The two manual pilot prospects stay excluded from automated emails and
				follow-ups.
			</p>
			<p>
				The pilot observes one business day after all ten automated initial
				emails are logged. Weekly sending starts automatically after successful
				checks. Expansion requires no pilot bounces and no uncertain deliveries.
				A pilot bounce pauses expansion for review.
			</p>
			{!campaign.approved && (
				<Alert>
					<AlertTitle>Approve the updated workflow before launch</AlertTitle>
					<AlertDescription>
						Approval covers templates, personalisation, automatic eligibility,
						same-company referrals and pilot expansion.
					</AlertDescription>
				</Alert>
			)}
			<Alert role="status">
				<AlertTitle>Sending and pause status</AlertTitle>
				<AlertDescription>
					<p>
						{campaign.deliveries.inProgress} emails in progress ·{" "}
						{campaign.deliveries.unconfirmed} deliveries unconfirmed.
					</p>
					<p>
						Pause stops new send attempts. It cannot recall messages already in
						progress. Unconfirmed deliveries require reconciliation before
						retry.
					</p>
				</AlertDescription>
			</Alert>
		</div>
	);
}
