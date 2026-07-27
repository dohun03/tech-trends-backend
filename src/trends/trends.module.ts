import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechTrend } from './entities/tech-trend.entity';
import { TrendsPipelineService } from './trends-pipeline.service';
import { DevToScraper } from './scrapers/devto.scraper';
import { AiModule } from 'ai/ai.module';
import { TrendsScheduler } from './trends.scheduler';
import { TrendsController } from './trends.controller';
import { TrendsQueryService } from './trends-query.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TechTrend]),
    AiModule,
  ],
  controllers: [TrendsController],
  providers: [
    TrendsQueryService,
    TrendsPipelineService,
    TrendsScheduler,
    DevToScraper,
  ],
  exports: [
    TrendsPipelineService,
  ],
})
export class TrendsModule {}