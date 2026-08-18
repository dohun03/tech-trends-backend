import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { TrendsPipelineService } from './trends-pipeline.service';
import { TechTrendRepository } from './repositories/tech-trend.repository';
import { DevToScraper } from './scrapers/devto.scraper';
import { GeekNewsScraper } from './scrapers/geek-news.scraper';
import { StackOverflowScraper } from './scrapers/stackoverflow.scraper';
import { Article, ArticleDetails } from './interfaces/scraper.interface';
import { AiService } from '../ai/ai.service';
import { RedisService } from 'redis/redis.service';

describe('TrendsPipelineService', () => {
  let pipelineService: TrendsPipelineService;
  let devToScraper: jest.Mocked<DevToScraper>;
  let repository: jest.Mocked<TechTrendRepository>;
  let aiService: jest.Mocked<AiService>;

  const mockArticle: Article = {
    id: '101',
    title: 'NestJS Pipeline Architecture',
    url: 'https://dev.to/article/101',
    created_at: '2026-08-18',
    source: 'dev.to',
  };

  const mockArticleDetails: ArticleDetails = {
    content: 'Detailed content about NestJS pipeline implementation. This is long enough to be valid.',
    view_count: 100,
    like_count: 50,
    comment_count: 10,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrendsPipelineService,
        {
          provide: getQueueToken('trend-scraper-queue'),
          useValue: { add: jest.fn(), process: jest.fn() },
        },
        {
          provide: TechTrendRepository,
          useValue: {
            findExistingSourceIds: jest.fn(),
            saveTrend: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: { acquireLock: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue: any) => {
              if (key === 'SCRAPER_AI_DELAY_SECONDS') return 0;
              return defaultValue;
            }),
          },
        },
        {
          provide: AiService,
          useValue: {
            filterBatchWithAi: jest.fn(),
            summarizeContentWithAi: jest.fn(),
            vectorEmbeddingWithAi: jest.fn(),
          },
        },
        {
          provide: DevToScraper,
          useValue: {
            sourceName: 'dev.to',
            getArticles: jest.fn(),
            getArticleDetails: jest.fn(),
          },
        },
        {
          provide: GeekNewsScraper,
          useValue: {
            sourceName: 'geeknews',
            getArticles: jest.fn(),
            getArticleDetails: jest.fn(),
          },
        },
        {
          provide: StackOverflowScraper,
          useValue: {
            sourceName: 'stackoverflow',
            getArticles: jest.fn(),
            getArticleDetails: jest.fn(),
          },
        },
      ],
    }).compile();

    pipelineService = module.get<TrendsPipelineService>(TrendsPipelineService);
    devToScraper = module.get(DevToScraper);
    repository = module.get(TechTrendRepository);
    aiService = module.get(AiService);

    if (pipelineService['scraperMap']) {
      pipelineService['scraperMap'].set('DEVTO', devToScraper);
    }
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  beforeEach(() => {
    devToScraper.getArticles.mockResolvedValue([mockArticle]);
    repository.findExistingSourceIds.mockResolvedValue(new Set());
    devToScraper.getArticleDetails.mockResolvedValue(mockArticleDetails);
  });

  describe('정상 파이프라인 실행', () => {
    it('[성공] 모든 단계가 성공적으로 수행되면 저장된 아티클 정보를 반환해야 한다', async () => {
      // 리턴 값 세팅
      aiService.filterBatchWithAi.mockResolvedValue(['101']);
      aiService.summarizeContentWithAi.mockResolvedValue({
        title: '요약 제목',
        short_summary: ['요약 1'],
        long_summary: '상세 요약 본문',
        tags: 'NestJS, Backend',
      });
      aiService.vectorEmbeddingWithAi.mockResolvedValue([[0.1, 0.2, 0.3]]);
      repository.saveTrend.mockResolvedValue({ id: 1, source_id: '101' } as any);

      // 실행
      const result = await pipelineService.executeScraperByName('DEVTO');

      expect(result.savedCount).toBe(1);
      expect(result.savedArticles[0].sourceId).toBe('101');
      expect(repository.saveTrend).toHaveBeenCalledTimes(1);
    });
  });

  describe('치명적 에러 발생 시 전체 실패(Throw) 검증', () => {
    it('[미등록스크래퍼-실패] 등록되지 않은 스크래퍼 소스명 요청 시 예외를 던져야 한다', async () => {
      await expect(pipelineService.executeScraperByName('INVALID_SOURCE')).rejects.toThrow(
        '[Pipeline] 등록되지 않은 스크래퍼 소스입니다: INVALID_SOURCE',
      );
    });

    it('[목록수집-실패] 스크래퍼 목록 조회 중 에러 발생 시 예외를 던져야 한다', async () => {
      devToScraper.getArticles.mockRejectedValueOnce(new Error('Network Connection Timeout'));

      await expect(pipelineService.executeScraperByName('DEVTO')).rejects.toThrow(
        'Network Connection Timeout',
      );
    });

    it('[AI필터-실패] AI 가치 평가 API 에러 발생 시 예외를 던져야 한다', async () => {
      aiService.filterBatchWithAi.mockRejectedValueOnce(new Error('Groq Filter API Error'));

      await expect(pipelineService.executeScraperByName('DEVTO')).rejects.toThrow(
        'Groq Filter API Error',
      );
    });

    it('[임베딩-실패] AI 임베딩 API 에러 발생 시 예외를 던져야 한다', async () => {
      aiService.filterBatchWithAi.mockResolvedValue(['101']);
      aiService.summarizeContentWithAi.mockResolvedValue({
        title: '제목',
        short_summary: ['요약'],
        long_summary: '상세',
        tags: 'NestJS',
      });

      aiService.vectorEmbeddingWithAi.mockRejectedValueOnce(new Error('Embedding Service Down'));

      await expect(pipelineService.executeScraperByName('DEVTO')).rejects.toThrow(
        'Embedding Service Down',
      );
    });
  });

  describe('부분 에러 발생 시 개별 스킵(Skip) 처리 검증', () => {
    it('[본문수집-스킵] 특정 아티클 본문 수집 실패 시 해당 아티클만 제외하고 진행해야 한다', async () => {
      devToScraper.getArticles.mockResolvedValue([
        { ...mockArticle, id: '101' },
        { ...mockArticle, id: '102' },
      ]);

      devToScraper.getArticleDetails.mockImplementation(async (id) => {
        if (id === '101') throw new Error('Detail Fetch Failed');
        return mockArticleDetails;
      });

      aiService.filterBatchWithAi.mockResolvedValue(['102']);
      aiService.summarizeContentWithAi.mockResolvedValue({
        title: '요약', short_summary: ['짧은요약'], long_summary: '상세', tags: 'NestJS',
      });
      aiService.vectorEmbeddingWithAi.mockResolvedValue([[0.1, 0.2]]);
      repository.saveTrend.mockResolvedValue({ id: 2, source_id: '102' } as any);

      const result = await pipelineService.executeScraperByName('DEVTO');

      expect(result.savedCount).toBe(1);
      expect(result.savedArticles[0].sourceId).toBe('102');
    });

    it('[AI요약-스킵] 개별 아티클 요약 실패 시 전체가 멈추지 않고 다음 아티클을 진행해야 한다', async () => {
      devToScraper.getArticles.mockResolvedValue([
        { ...mockArticle, id: '101' },
        { ...mockArticle, id: '102' },
      ]);
      devToScraper.getArticleDetails.mockResolvedValue(mockArticleDetails);
      aiService.filterBatchWithAi.mockResolvedValue(['101', '102']);

      aiService.summarizeContentWithAi
        .mockRejectedValueOnce(new Error('Summary Failed for 101'))
        .mockResolvedValueOnce({
          title: '요약', short_summary: ['짧은요약'], long_summary: '상세', tags: 'NestJS',
        });

      aiService.vectorEmbeddingWithAi.mockResolvedValue([[0.1, 0.2]]);
      repository.saveTrend.mockResolvedValue({ id: 2, source_id: '102' } as any);

      const result = await pipelineService.executeScraperByName('DEVTO');

      expect(result.savedCount).toBe(1);
      expect(result.savedArticles[0].sourceId).toBe('102');
    });

    it('[DB저장-스킵] 개별 DB 저장 실패 시 전체가 멈추지 않고 진행되어야 한다', async () => {
      devToScraper.getArticles.mockResolvedValue([
        { ...mockArticle, id: '101' },
        { ...mockArticle, id: '102' },
      ]);
      devToScraper.getArticleDetails.mockResolvedValue(mockArticleDetails);
      aiService.filterBatchWithAi.mockResolvedValue(['101', '102']);
      aiService.summarizeContentWithAi.mockResolvedValue({
        title: '요약', short_summary: ['요약'], long_summary: '상세', tags: 'NestJS',
      });
      aiService.vectorEmbeddingWithAi.mockResolvedValue([[0.1], [0.2]]);

      repository.saveTrend
        .mockRejectedValueOnce(new Error('DB Unique Constraint Error'))
        .mockResolvedValueOnce({ id: 2, source_id: '102' } as any);

      const result = await pipelineService.executeScraperByName('DEVTO');

      expect(result.savedCount).toBe(1);
      expect(result.savedArticles[0].sourceId).toBe('102');
    });
  });

  describe('데이터 없음 및 조기 종료 분기 검증', () => {
    it('[수집결과0건] 스크래퍼가 가져온 글이 없으면 savedCount 0을 반환해야 한다', async () => {
      devToScraper.getArticles.mockResolvedValue([]);

      const result = await pipelineService.executeScraperByName('DEVTO');

      expect(result.savedCount).toBe(0);
      expect(aiService.filterBatchWithAi).not.toHaveBeenCalled();
    });

    it('[신규글0건] 수집된 글이 모두 DB에 이미 저장되어 있으면 savedCount 0을 반환해야 한다', async () => {
      devToScraper.getArticles.mockResolvedValue([mockArticle]);
      repository.findExistingSourceIds.mockResolvedValue(new Set(['101']));

      const result = await pipelineService.executeScraperByName('DEVTO');

      expect(result.savedCount).toBe(0);
      expect(aiService.filterBatchWithAi).not.toHaveBeenCalled();
    });

    it('[가치평가0건] AI 가치 평가를 통과한 아티클이 없으면 savedCount 0을 반환해야 한다', async () => {
      devToScraper.getArticles.mockResolvedValue([mockArticle]);
      repository.findExistingSourceIds.mockResolvedValue(new Set());
      devToScraper.getArticleDetails.mockResolvedValue(mockArticleDetails);
      aiService.filterBatchWithAi.mockResolvedValue([]);

      const result = await pipelineService.executeScraperByName('DEVTO');

      expect(result.savedCount).toBe(0);
      expect(aiService.summarizeContentWithAi).not.toHaveBeenCalled();
    });
  });
});