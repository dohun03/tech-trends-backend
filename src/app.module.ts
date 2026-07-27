// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { ScheduleModule } from '@nestjs/schedule';
import { TrendsModule } from 'trends/trends.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true, 
      envFilePath: '.env',
    }),
    DatabaseModule,
    TrendsModule,
  ],
})
export class AppModule {}