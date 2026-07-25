import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { TechTrend } from '../database/entities/tech-trend.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TrendsModule } from 'trends/trends.module';
import { AiModule } from 'ai/ai.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TechTrend]),
    TrendsModule,
    AiModule,
  ],
  controllers: [ApiController],
  providers: [ApiService],
})
export class ApiModule {}