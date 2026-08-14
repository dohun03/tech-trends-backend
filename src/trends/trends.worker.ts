import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { TrendsPipelineService } from './trends-pipeline.service';

@Processor('trend-scraper-queue', { concurrency: 1 })
export class TrendsWorker extends WorkerHost {
  private readonly logger = new Logger(TrendsWorker.name);

  constructor(private readonly trendsPipelineService: TrendsPipelineService) {
    super();
  }

  // Redis의 스크래퍼 큐 감시 및 실행
  async process(job: Job<{ sourceName: string }>): Promise<void> {
    const { sourceName } = job.data;
    this.logger.log(`[Worker] 수집 작업 시작: ${sourceName} (Job ID: ${job.id})`);

    try {
      await this.trendsPipelineService.executeScraperByName(sourceName);
      this.logger.log(`[Worker] 수집 작업 완료: ${sourceName}`);
    } catch (error: any) {
      this.logger.error(`[Worker] 수집 작업 실패: ${sourceName}`, error.stack);
      throw error;
    }
  }
}