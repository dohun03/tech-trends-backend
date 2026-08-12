import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { RedisModule } from 'redis/redis.module';

@Module({
  imports: [
    RedisModule,
  ],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}