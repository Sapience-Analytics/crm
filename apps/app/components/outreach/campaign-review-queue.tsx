import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@crm/ui/components/card";
import { ToggleGroup, ToggleGroupItem } from "@crm/ui/components/toggle-group";
import type { RouterOutputs } from "@/lib/trpc/types";

type ReviewQueue = RouterOutputs["outreach"]["status"]["reviewQueue"];
export type ReviewView = keyof ReviewQueue | "all";

export function CampaignReviewQueue({
	counts,
	view,
	onViewChange,
}: {
	counts: ReviewQueue;
	view: ReviewView;
	onViewChange: (view: ReviewView) => void;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Review queue</CardTitle>
				<CardDescription>
					Choose a view to review the prospects below. Counts show prospects in
					each queue.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="overflow-x-auto">
					<ToggleGroup
						type="single"
						variant="outline"
						value={view}
						aria-label="Prospect review queue"
						onValueChange={(value) => {
							if (
								value === "all" ||
								value === "replies" ||
								value === "referrals" ||
								value === "qualification" ||
								value === "deliveries"
							)
								onViewChange(value);
						}}
					>
						<ToggleGroupItem value="all">All prospects</ToggleGroupItem>
						<ToggleGroupItem value="replies">
							Replies to review ({counts.replies})
						</ToggleGroupItem>
						<ToggleGroupItem value="referrals">
							Referral holds ({counts.referrals})
						</ToggleGroupItem>
						<ToggleGroupItem value="qualification">
							Qualification holds ({counts.qualification})
						</ToggleGroupItem>
						<ToggleGroupItem value="deliveries">
							Unsettled sends ({counts.deliveries})
						</ToggleGroupItem>
					</ToggleGroup>
				</div>
			</CardContent>
		</Card>
	);
}
