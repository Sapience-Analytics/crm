import { Module } from "@nestjs/common";
import { GoogleModule } from "../google/google.module";
import { MailboxModule } from "../mailbox/mailbox.module";
import { TrpcModule } from "../trpc/trpc.module";
import { OutreachController } from "./outreach.controller";
import { OutreachRouter } from "./outreach.router";
import { OutreachService } from "./outreach.service";
import { OutreachDispatchService } from "./outreach-dispatch.service";
import { OutreachGmail } from "./outreach-gmail";
import { OutreachLaunchTestsService } from "./outreach-launch-tests.service";

@Module({
	imports: [GoogleModule, MailboxModule, TrpcModule],
	providers: [
		OutreachService,
		OutreachGmail,
		OutreachDispatchService,
		OutreachRouter,
		OutreachLaunchTestsService,
	],
	controllers: [OutreachController],
})
export class OutreachModule {}
