import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechTrend } from '../database/entities/tech-trend.entity';
import { TrendsService } from './trends.service';
import { DevToScraper } from './scrapers/devto.scraper';
import { AiModule } from 'ai/ai.module';
import { TrendsScheduler } from './trends.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([TechTrend]),
    AiModule,
  ],
  providers: [
    TrendsService,
    TrendsScheduler,
    DevToScraper,
  ],
  exports: [
    TrendsService,
  ],
})
export class TrendsModule {}