import type { Metadata } from "next";
import { GeotabCampaign } from "@/components/outreach/geotab-campaign";
import {
	PageShell,
	PageShellContent,
	PageShellHeader,
	PageShellHeading,
	PageShellTitle,
} from "@/components/page-shell";

export const metadata: Metadata = { title: "Geotab prospecting" };

export default function GeotabPage() {
	return (
		<PageShell>
			<PageShellHeader>
				<PageShellHeading>
					<PageShellTitle>Geotab prospecting</PageShellTitle>
				</PageShellHeading>
			</PageShellHeader>
			<PageShellContent>
				<GeotabCampaign />
			</PageShellContent>
		</PageShell>
	);
}
