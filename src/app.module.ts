// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { TrendsModule } from 'trends/trends.module';
import { BullModule } from '@nestjs/bullmq';
import { WinstonModule } from 'nest-winston';
import { winstonLoggerOptions } from './common/config/logger.config';

@Module({
  imports: [
    WinstonModule.forRoot(winstonLoggerOptions),
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true, 
      envFilePath: '.env',
    }),

    // BullMQ Redis 연결 기본 설정
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST') || 'localhost',
          port: configService.get<number>('REDIS_PORT') || 6379,
          password: configService.get<string>('REDIS_PASSWORD'),
        },
      }),
    }),
    // 트렌드 수집용 큐 등록
    BullModule.registerQueue({
      name: 'trend-scraper-queue',
    }),

    // 10초에 10번으로 요청 제한
    ThrottlerModule.forRoot([
      {
        ttl: 10000,
        limit: 10,
      },
    ]),
    DatabaseModule,
    TrendsModule,
  ],
  providers: [
    // 모든 컨트롤러에 Throttler 자동 적용
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}