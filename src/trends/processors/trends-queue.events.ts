import { OnQueueEvent, QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ScrapeJobResult } from '../interfaces/scraper.interface';

@QueueEventsListener('trend-scraper-queue')
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

    const baseUrl = this.configService.get<string>('CLIENT_URL', 'http://localhost:3000');

    // 관리자용 모니터링 알림 메시지
    let adminMessage = `✅ **[BullMQ 스크래퍼 성공]**\n- Job ID: \`${event.jobId}\``;
    if (result) {
      adminMessage += `\n- 수집 출처: \`${result.sourceName}\``;
      adminMessage += `\n- 저장 건수: **${result.savedCount}개**`;
    }

    // 유저용 아티클 알림 메시지
    let userMessage = '';
    if (result && result.savedArticles && result.savedArticles.length > 0) {
      userMessage = `📢 **[${result.sourceName}] 새로운 트렌드 아티클이 도착했습니다!**\n`;
      
      for (let idx = 0; idx < result.savedArticles.length; idx++) {
        const article = result.savedArticles[idx];
        const detailUrl = `${baseUrl}/?id=${article.id}`;
        const appendStr = `\n${idx + 1}. [${article.title}](<${detailUrl}>)`;
        
        if (userMessage.length + appendStr.length > 1900) {
          userMessage += `\n\n...외 **${result.savedArticles.length - idx}개**의 아티클이 더 있습니다.`;
          break;
        }
        
        userMessage += appendStr;
      }
    }

    // 관리자 채널 발송
    await this.sendNotification(adminMessage, 'ADMIN');

    // 유저 채널 발송
    if (userMessage) {
      await this.sendNotification(userMessage, 'USER');
    }
  }

  // 작업 실패 시 실행
  @OnQueueEvent('failed')
  async onFailed(event: { jobId: string; failedReason: string }) {
    this.logger.error(`[Queue Error] Job ${event.jobId} 실패: ${event.failedReason}`);

    const adminMessage = `🚨 **[BullMQ 스크래퍼 실패]**\n- Job ID: \`${event.jobId}\`\n- 사유: \`${event.failedReason}\``;
    await this.sendNotification(adminMessage, 'ADMIN');
  }

  // 공통 디스코드 발송 함수
  private async sendNotification(message: string, target: 'ADMIN' | 'USER') {
    const envKey = target === 'ADMIN' ? 'DISCORD_ADMIN_WEBHOOK_URL' : 'DISCORD_USER_WEBHOOK_URL';
    const webhookUrl = this.configService.get<string>(envKey);

    if (!webhookUrl) {
      this.logger.warn(`Discord Webhook URL이 설정되지 않았습니다: ${envKey}`);
      return;
    }

    let safeMessage = message;
    if (safeMessage.length > 2000) {
      safeMessage = safeMessage.substring(0, 1950) + '\n\n... (길이 초과로 절삭됨)';
    }

    try {
      await axios.post(webhookUrl, { content: safeMessage });
    } catch (err: any) {
      this.logger.error(`Discord (${target}) 발송 실패: ${err.message}`);
    }
  }
}