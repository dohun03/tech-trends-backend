import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { TrendsPipelineService } from './trends-pipeline.service';
import { ScrapeJobResult } from './interfaces/scraper.interface';
import { RedisService } from 'redis/redis.service';

@Processor('trend-scraper-queue', { concurrency: 1 })
export class TrendsWorker extends WorkerHost {
  private readonly logger = new Logger(TrendsWorker.name);

  constructor(
    private readonly trendsPipelineService: TrendsPipelineService,
    private readonly redisService: RedisService,
  ) {
    super();
  }

  // Redis의 스크래퍼 큐 감시 및 실행
  async process(job: Job<{ sourceName: string; lockValue: string }>): Promise<ScrapeJobResult> {
    const { sourceName, lockValue } = job.data;
    this.logger.log(`[Worker] 수집 작업 시작: ${sourceName} (Job ID: ${job.id})`);

    try {
      const result = await this.trendsPipelineService.executeScraperByName(sourceName);
      
      this.logger.log(`[Worker] 수집 작업 완료: ${sourceName}`);

      return result;

    } catch (error: any) {
      this.logger.error(`[Worker] 수집 작업 실패: ${sourceName}`, error.stack);
      throw error;
    } finally {
      if (lockValue) {
        const lockKey = `lock:scraper:${sourceName}`;
        await this.redisService.releaseLock({ key: lockKey, value: lockValue });
        this.logger.log(`[Worker] ${sourceName} 락 해제 완료`);
      }
    }
  }
}