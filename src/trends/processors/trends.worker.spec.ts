import { Test, TestingModule } from '@nestjs/testing';
import { TrendsWorker } from './trends.worker';
import { TrendsPipelineService } from 'trends/services/trends-pipeline.service';
import { RedisService } from 'redis/redis.service';

describe('TrendsWorker', () => {
  let worker: TrendsWorker;
  let pipelineService: jest.Mocked<TrendsPipelineService>;
  let redisService: jest.Mocked<RedisService>;

  beforeEach(async () => {
    const mockPipelineService = { executeScraperByName: jest.fn() };
    const mockRedisService = { releaseLock: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrendsWorker,
        { provide: TrendsPipelineService, useValue: mockPipelineService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    worker = module.get<TrendsWorker>(TrendsWorker);
    pipelineService = module.get(TrendsPipelineService);
    redisService = module.get(RedisService);
  });

  it('수집 작업 성공 시 결과 반환 및 Redis 락을 해제해야 한다', async () => {
    const mockJob = { id: '1', data: { sourceName: 'DEVTO', lockValue: 'uuid-123' } } as any;
    pipelineService.executeScraperByName.mockResolvedValue({ processedCount: 5 } as any);

    const result = await worker.process(mockJob);

    expect(result).toEqual({ processedCount: 5 });
    expect(redisService.releaseLock).toHaveBeenCalledWith({
      key: 'lock:scraper:DEVTO',
      value: 'uuid-123',
    });
  });

  it('수집 작업 실패 시에도 finally 블록에서 Redis 락을 해제해야 한다', async () => {
    const mockJob = { id: '2', data: { sourceName: 'DEVTO', lockValue: 'uuid-123' } } as any;
    pipelineService.executeScraperByName.mockRejectedValue(new Error('수집 에러'));

    await expect(worker.process(mockJob)).rejects.toThrow('수집 에러');
    expect(redisService.releaseLock).toHaveBeenCalledWith({
      key: 'lock:scraper:DEVTO',
      value: 'uuid-123',
    });
  });
});