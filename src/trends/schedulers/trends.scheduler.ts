import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TrendsPipelineService } from '../services/trends-pipeline.service';

@Injectable()
export class TrendsScheduler {
  private readonly logger = new Logger(TrendsScheduler.name);

  constructor(private readonly trendsPipelineService: TrendsPipelineService) {}

  @Cron('0 1 * * *', { name: 'devto-trends-collector', timeZone: 'Asia/Seoul' })
  async handleDailyTrendsCron() {
    this.logger.log('[Scheduler] 트렌드 수집 큐 등록 시작');
    await this.trendsPipelineService.dispatchAllScrapersToQueue();
  }
}