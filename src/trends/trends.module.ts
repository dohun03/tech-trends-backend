import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechTrend } from '../database/entities/tech-trend.entity';
import { TrendsService } from './trends.service';
import { DevToScraper } from './scrapers/devto.scraper';
// import { GeminiService } from './ai/gemini.service';
// import { TrendsScheduler } from './trends.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([TechTrend]),
  ],
  providers: [
    TrendsService,
    DevToScraper,
    // GeminiService,
    // TrendsScheduler,
  ],
  exports: [
    TrendsService,
  ],
})
export class TrendsModule {}