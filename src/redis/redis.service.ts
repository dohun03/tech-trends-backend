import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

export interface LockParams {
  key: string;
  ttlMs?: number;
}

export interface GetCacheParams {
  key: string;
}

export interface SetCacheParams {
  key: string;
  value: any;
  ttlSeconds?: number;
}

export interface DelCacheParams {
  key: string;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const host = this.configService.get<string>('REDIS_HOST') || 'localhost';
    const port = Number(this.configService.get<number>('REDIS_PORT')) || 6379;
    const password = this.configService.get<string>('REDIS_PASSWORD') || undefined;

    this.client = new Redis({ host, port, password });

    this.client.on('connect', () => {
      this.logger.log('Redis 서버에 성공적으로 연결되었습니다.');
    });

    this.client.on('error', (err) => {
      this.logger.error(`Redis 연결 에러: ${err.message}`, err.stack);
    });
  }

  onModuleDestroy() {
    this.client.disconnect();
  }


  // 분산락을 획득합니다
  async acquireLock(params: { key: string; ttlMs: number }): Promise<string | null> {
    const { key, ttlMs } = params;
    const lockValue = randomUUID();

    const result = await this.client.set(key, lockValue, 'PX', ttlMs, 'NX');
    return result === 'OK' ? lockValue : null;
  }

  // 분산락을 해제합니다.
  async releaseLock(params: { key: string; value: string }): Promise<boolean> {
    const { key, value } = params;

    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.client.eval(luaScript, 1, key, value);
    return result === 1;
  }


  // 캐시 데이터를 조회합니다.
  async getCache<T>(params: GetCacheParams): Promise<T | null> {
    const { key } = params;
    const data = await this.client.get(key);
    if (!data) return null;

    try {
      return JSON.parse(data) as T;
    } catch {
      return data as unknown as T;
    }
  }

  // 데이터를 캐싱합니다.
  async setCache(params: SetCacheParams): Promise<void> {
    const { key, value, ttlSeconds = 2592000 } = params;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    if (ttlSeconds > 0) {
      await this.client.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, serialized);
    }
  }

  // 특정 캐시 키를 삭제합니다.
  async delCache(params: DelCacheParams): Promise<void> {
    const { key } = params;
    await this.client.del(key);
  }
}