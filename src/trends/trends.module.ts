import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechTrend } from './entities/tech-trend.entity';
import { TrendsPipelineService } from './services/trends-pipeline.service';
import { AiModule } from 'ai/ai.module';
import { TrendsScheduler } from './schedulers/trends.scheduler';
import { TrendsController } from './trends.controller';
import { TrendsQueryService } from './services/trends-query.service'; 
import { TechTrendRepository } from './repositories/tech-trend.repository';
import { DevToScraper } from './scrapers/devto.scraper';
import { GeekNewsScraper } from './scrapers/geek-news.scraper';
import { StackOverflowScraper } from './scrapers/stackoverflow.scraper';
import { ScraperFactory } from './scrapers/scraper.factory';
import { RedisModule } from 'redis/redis.module';
import { BullModule } from '@nestjs/bullmq';
import { TrendsWorker } from './processors/trends.worker';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { TrendQueueEventsListener } from './processors/trends-queue.events';

@Module({
  imports: [
    TypeOrmModule.forFeature([TechTrend]),
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature({
      name: 'trend-scraper-queue',
      adapter: BullMQAdapter,
    }),
    BullModule.registerQueue({
      name: 'trend-scraper-queue',
    }),
    AiModule,
    RedisModule,
  ],
  controllers: [TrendsController],
  providers: [
    TechTrendRepository,
    TrendsQueryService,
    TrendsPipelineService,
    TrendsWorker,
    TrendsScheduler,
    TrendQueueEventsListener,
    ScraperFactory,
    DevToScraper,
    GeekNewsScraper,
    StackOverflowScraper,
  ],
  exports: [
    TrendsPipelineService,
  ],
})
export class TrendsModule {}