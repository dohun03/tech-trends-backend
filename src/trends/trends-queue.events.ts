import { OnQueueEvent, QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ScrapeJobResult } from './interfaces/scraper.interface';

@QueueEventsListener('trend-scraper-queue') // 등록한 큐 이름
export class TrendQueueEventsListener extends QueueEventsHost {
  private readonly logger = new Logger(TrendQueueEventsListener.name);

  constructor(private readonly configService: ConfigService) {
    super();
  }
  
  // 작업 성공 시 실행
  @OnQueueEvent('completed')
  async onCompleted(event: { jobId: string; returnvalue: string | ScrapeJobResult }) {
    this.logger.log(`[Queue Success] Job ${event.jobId} 완료`);

    let result: ScrapeJobResult | null = null;
    try {
      result = typeof event.returnvalue === 'string'
        ? JSON.parse(event.returnvalue)
        : event.returnvalue;
    } catch (_) {
      result = null;
    }

    // 알림 메시지 본문
    let message = `✅ **[BullMQ 스크래퍼 성공]**\n- Job ID: \`${event.jobId}\``;

    if (result) {
      message += `\n- 수집 출처: \`${result.sourceName}\``;
      message += `\n- 저장 건수: **${result.savedCount}개**`;

      if (result.savedArticles && result.savedArticles.length > 0) {
        message += `\n\n📌 **수집된 아티클 목록:**`;
        result.savedArticles.forEach((article, idx) => {
          message += `\n${idx + 1}. [${article.title}](${article.url})`;
        });
      } else {
        message += `\n- *신규 아티클이 없거나 AI 평가 통과 항목이 없습니다.*`;
      }
    }

    await this.sendNotification(message);
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