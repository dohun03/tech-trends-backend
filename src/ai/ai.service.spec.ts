import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from './ai.service';
import { ConfigService } from '@nestjs/config';
import { RedisService } from 'redis/redis.service';

describe('AiService', () => {
  let service: AiService;
  let redisService: jest.Mocked<RedisService>;

  // 내부적으로 사용될 가짜 Groq, Gemini 객체
  let mockGroqCreate: jest.Mock;
  let mockGeminiEmbed: jest.Mock;

  beforeEach(async () => {
    // RedisService Mocking
    const mockRedisServiceProvider = {
      provide: RedisService,
      useValue: {
        getCache: jest.fn(),
        setCache: jest.fn(),
        acquireLock: jest.fn(),
        releaseLock: jest.fn(),
      },
    };

    // ConfigService Mocking
    const mockConfigServiceProvider = {
      provide: ConfigService,
      useValue: {
        getOrThrow: jest.fn((key: string) => {
          if (key === 'GROQ_MODEL') return 'llama3-8b-8192';
          if (key === 'GEMINI_EMBEDDING_MODEL') return 'text-embedding-004';
          return 'mock-key';
        }),
        get: jest.fn((key: string) => {
          if (key === 'EMBEDDING_TTL_SECONDS') return 3600;
          return 'mock-key';
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AiService, mockConfigServiceProvider, mockRedisServiceProvider],
    }).compile();

    service = module.get<AiService>(AiService);
    redisService = module.get(RedisService);

    // 외부 API (Groq, Gemini) Mocking
    mockGroqCreate = jest.fn();
    (service as any).groq = {
      chat: { completions: { create: mockGroqCreate } },
    };

    mockGeminiEmbed = jest.fn();
    (service as any).gemini = {
      models: { embedContent: mockGeminiEmbed },
    };

    // setTimeout 대기 시간 무시
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
      cb();
      return 0 as any;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('filterBatchWithAi', () => {
    it('성공: AI 응답을 JSON으로 파싱하여 valuable_ids를 반환해야 한다', async () => {
      // 리턴 값 정의
      const mockResponse = {
        choices: [{ message: { content: '{"valuable_ids": [1, 2, 3]}' } }],
      };
      mockGroqCreate.mockResolvedValue(mockResponse);

      // 실행
      const result = await service.filterBatchWithAi({ items: [] as any });

      // 검증
      expect(result).toEqual([1, 2, 3]);
      expect(mockGroqCreate).toHaveBeenCalledTimes(1);
    });

    it('실패: 3번 재시도 후에도 실패하면 에러를 던져야 한다', async () => {
      // 리턴 값 정의
      mockGroqCreate.mockRejectedValue(new Error('API 에러'));

      // 실행 / 검증
      await expect(service.filterBatchWithAi({ items: [] as any })).rejects.toThrow('API 에러');
      expect(mockGroqCreate).toHaveBeenCalledTimes(3); // 3번 시도했는지 검증
    });
  });

  describe('summarizeContentWithAi', () => {
    it('성공: 응답을 파싱하여 정해진 포맷으로 반환해야 한다 (short_summary 배열 처리 등)', async () => {
      // 리턴 값 정의
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: '테스트 제목',
                short_summary: '문장 하나뿐인 요약', // 배열이 아닌 문자열로 올 경우
                long_summary: '긴 요약입니다.',
                tags: ['NestJS', 'Redis'],
              }),
            },
          },
        ],
      };
      mockGroqCreate.mockResolvedValue(mockResponse);

      // 실행
      const result = await service.summarizeContentWithAi({
        title: '원본 제목',
        content: '내용',
      });

      // 검증
      expect(result).toEqual({
        title: '테스트 제목',
        short_summary: ['문장 하나뿐인 요약'], // 배열로 강제 변환되었는지 검증
        long_summary: '긴 요약입니다.',
        tags: 'NestJS, Redis', // 문자열로 조인되었는지 검증
      });
    });
  });

  describe('vectorEmbeddingWithAi', () => {
    it('입력값이 없으면 API를 호출하지 않고 빈 배열을 반환해야 한다', async () => {
      const result = await service.vectorEmbeddingWithAi({ texts: [] });
      expect(result).toEqual([]);
      expect(mockGeminiEmbed).not.toHaveBeenCalled();
    });

    it('성공: Gemini API를 호출하고 벡터 배열을 반환해야 한다', async () => {
      mockGeminiEmbed.mockResolvedValue({
        embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }],
      });

      const result = await service.vectorEmbeddingWithAi({
        texts: ['text1', 'text2'],
      });

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });
  });

  describe('embedSearchQuery', () => {
    const query = '  NestJS    Redis  ';
    const cacheKey = 'emb:text-embedding-004:nestjs redis';

    it('시나리오 A: 캐시가 존재하면 API 호출 없이 캐시값을 반환해야 한다 (Cache Hit)', async () => {
      const cachedVector = [0.9, 0.8, 0.7];
      redisService.getCache.mockResolvedValue(cachedVector);

      const result = await service.embedSearchQuery(query);

      expect(result).toEqual(cachedVector);
      expect(mockGeminiEmbed).not.toHaveBeenCalled(); 
      expect(redisService.acquireLock).not.toHaveBeenCalled(); 
    });

    it('시나리오 B: 캐시가 없고 락을 획득하면, API를 호출하고 캐시를 저장한 뒤 락을 해제해야 한다', async () => {
      redisService.getCache.mockResolvedValue(null);
      redisService.acquireLock.mockResolvedValue('mock-uuid-lock');
      mockGeminiEmbed.mockResolvedValue({ embeddings: [{ values: [0.1, 0.1, 0.1] }] });

      const result = await service.embedSearchQuery(query);

      expect(result).toEqual([0.1, 0.1, 0.1]);
      expect(redisService.setCache).toHaveBeenCalledWith(
        expect.objectContaining({ key: cacheKey, value: [0.1, 0.1, 0.1] }),
      );
      expect(redisService.releaseLock).toHaveBeenCalledWith({
        key: `lock:${cacheKey}`,
        value: 'mock-uuid-lock',
      });
    });

    it('시나리오 C: 락 획득에 실패하면, 대기(waitForCache) 후 생성된 캐시를 반환해야 한다', async () => {
      redisService.getCache
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce([0.2, 0.2, 0.2]);

      redisService.acquireLock.mockResolvedValue(null); 

      const result = await service.embedSearchQuery(query);

      expect(result).toEqual([0.2, 0.2, 0.2]);
      expect(mockGeminiEmbed).not.toHaveBeenCalled(); 
      expect(redisService.setCache).not.toHaveBeenCalled(); 
    });

    it('시나리오 D: API 호출 중 에러가 발생하면 에러를 던지지 않고 null을 반환해야 한다', async () => {
      redisService.getCache.mockResolvedValue(null);
      redisService.acquireLock.mockResolvedValue('mock-lock');
      mockGeminiEmbed.mockRejectedValue(new Error('Gemini API quota exceeded'));

      const result = await service.embedSearchQuery(query);

      expect(result).toBeNull(); 
    });
  });
});