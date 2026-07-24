// src/trends/trends.scheduler.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TrendsService } from './trends.service';

@Injectable()
export class TrendsScheduler {
  private readonly logger = new Logger(TrendsScheduler.name);

  constructor(private readonly trendsService: TrendsService) {}

  @Cron('0 1 * * *', { name: 'devto-trends-collector', timeZone: 'Asia/Seoul' })
  async handleDailyTrendsCron() {
    this.logger.log('Cron : 수집 배치 작업을 시작합니다.');
    await this.trendsService.collectAndProcessTrends();
  }
}