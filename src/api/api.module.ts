import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { TechTrend } from '../database/entities/tech-trend.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    TypeOrmModule.forFeature([TechTrend])
  ],
  controllers: [ApiController],
  providers: [ApiService],
})
export class ApiModule {}