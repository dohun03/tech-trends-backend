import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechTrend } from './entities/tech-trend.entity';
import { TrendsPipelineService } from './trends-pipeline.service';
import { AiModule } from 'ai/ai.module';
import { TrendsScheduler } from './trends.scheduler';
import { TrendsController } from './trends.controller';
import { TrendsQueryService } from './trends-query.service';
import { TechTrendRepository } from './repositories/tech-trend.repository';
import { DevToScraper } from './scrapers/devto.scraper';
import { GeekNewsScraper } from './scrapers/geek-news.scraper';
import { StackOverflowScraper } from './scrapers/stackoverflow.scraper';
import { RedisModule } from 'redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TechTrend]),
    AiModule,
    RedisModule,
  ],
  controllers: [TrendsController],
  providers: [
    TechTrendRepository,
    TrendsQueryService,
    TrendsPipelineService,
    TrendsScheduler,
    DevToScraper,
    GeekNewsScraper,
    StackOverflowScraper,
  ],
  exports: [
    TrendsPipelineService,
  ],
})
export class TrendsModule {}