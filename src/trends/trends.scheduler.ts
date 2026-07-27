import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TrendsPipelineService } from './trends-pipeline.service';

@Injectable()
export class TrendsScheduler {
  private readonly logger = new Logger(TrendsScheduler.name);

  constructor(private readonly trendsPipelineService: TrendsPipelineService) {}

  @Cron('0 1 * * *', { name: 'devto-trends-collector', timeZone: 'Asia/Seoul' })
  async handleDailyTrendsCron() {
    this.logger.log('[Scheduler] 일일 트렌드 수집 크론 작업 개시');
    await this.trendsPipelineService.collectAndProcessTrends();
  }
}