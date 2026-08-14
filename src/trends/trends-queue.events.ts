import { OnQueueEvent, QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@QueueEventsListener('trend-scraper-queue') // 등록한 큐 이름
export class TrendQueueEventsListener extends QueueEventsHost {
  private readonly logger = new Logger(TrendQueueEventsListener.name);
  
  constructor(private readonly configService: ConfigService) {
    super();
  }
  
  // 작업 성공 시 실행
  @OnQueueEvent('completed')
  async onCompleted(event: { jobId: string; returnvalue: any }) {
    this.logger.log(`[Queue Success] Job ${event.jobId} 완료`);

    await this.sendNotification(
      `✅ **[BullMQ 스크래퍼 성공]**\n- Job ID: \`${event.jobId}\`\n- 결과: 완료되었습니다.`
    );
  }

  // 작업 실패 시 실행
  @OnQueueEvent('failed')
  async onFailed(event: { jobId: string; failedReason: string }) {
    this.logger.error(`[Queue Error] Job ${event.jobId} 실패: ${event.failedReason}`);

    await this.sendNotification(
      `🚨 **[BullMQ 스크래퍼 실패]**\n- Job ID: \`${event.jobId}\`\n- 사유: \`${event.failedReason}\``
    );
  }

  // 공통 발송 함수
  private async sendNotification(message: string) {
    const webhookUrl = this.configService.get<string>('DISCORD_WEBHOOK_URL');
    if (!webhookUrl) return;

    try {
      await axios.post(webhookUrl, { content: message });
    } catch (err: any) {
      this.logger.error(`Discord 발송 실패: ${err.message}`);
    }
  }
}