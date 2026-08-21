import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { TrendsController } from './trends.controller';
import { TrendsQueryService } from './services/trends-query.service';
import { TrendsPipelineService } from './services/trends-pipeline.service';

describe('TrendsController - Throttler Test', () => {
  let app: INestApplication;

  const mockTrendsQueryService = {
    searchTrends: jest.fn().mockResolvedValue({ data: [], meta: {} }),
  };
  const mockTrendsPipelineService = {};

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        // 1. ThrottlerModule 설정 (테스트 환경)
        ThrottlerModule.forRoot([{
          name: 'global',
          ttl: 10000,
          limit: 5,
        }]),
      ],
      controllers: [TrendsController],
      providers: [
        { provide: TrendsQueryService, useValue: mockTrendsQueryService },
        { provide: TrendsPipelineService, useValue: mockTrendsPipelineService },
        // 2. ThrottlerGuard 등록 확인
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('10초 내 5회까지는 성공하고, 6번째 요청은 429 에러를 반환해야 한다', async () => {
    const agent = request(app.getHttpServer());

    // 1~5번째 요청: 정상 통과 (200 OK)
    for (let i = 1; i <= 5; i++) {
      const res = await agent.get('/api/trends/search?search=nestjs');
      expect(res.status).toBe(200);
    }

    // 6번째 요청: 제한 초과 (429 Too Many Requests)
    const blockedRes = await agent.get('/api/trends/search?search=nestjs');
    expect(blockedRes.status).toBe(429);
  });
});