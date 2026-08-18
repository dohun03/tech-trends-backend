import { Test, TestingModule } from '@nestjs/testing';
import { TrendsQueryService } from './trends-query.service';
import { TechTrendRepository } from '../repositories/tech-trend.repository';
import { AiService } from 'ai/ai.service';
import { InternalServerErrorException, NotFoundException } from '@nestjs/common';

describe('TrendsQueryService', () => {
  let service: TrendsQueryService;
  let repository: jest.Mocked<TechTrendRepository>;
  let aiService: jest.Mocked<AiService>;

  beforeEach(async () => {
    const mockRepository = {
      listTrends: jest.fn(),
      searchHybrid: jest.fn(),
      searchKeyword: jest.fn(),
      findUniqueSources: jest.fn(),
      findById: jest.fn(),
    };

    const mockAiService = {
      embedSearchQuery: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrendsQueryService,
        { provide: TechTrendRepository, useValue: mockRepository },
        { provide: AiService, useValue: mockAiService },
      ],
    }).compile();

    service = module.get<TrendsQueryService>(TrendsQueryService);
    repository = module.get(TechTrendRepository);
    aiService = module.get(AiService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getTrends', () => {
    it('검색어가 없으면 listTrends를 호출하고 페이지네이션 메타데이터를 계산하여 반환해야 한다', async () => {
      const mockResult = {
        data: [{ id: 1, title: '테스트 아티클' }],
        totalCount: 12,
      };
      repository.listTrends.mockResolvedValue(mockResult as any);

      const result = await service.getTrends({});

      expect(repository.listTrends).toHaveBeenCalledWith({
        page: 1,
        limit: 5,
        source: 'ALL',
        isNew: false,
        sort: 'DESC',
      });
      expect(result).toEqual({
        data: mockResult.data,
        meta: {
          totalCount: 12,
          totalPages: 3, // Math.ceil(12 / 5) = 3
          itemsPerPage: 5,
          currentPage: 1,
        },
      });
    });

    it('검색어가 존재하고 AI 벡터 임베딩이 있으면 searchHybrid를 호출해야 한다', async () => {
      const mockVector = [0.1, 0.2, 0.3];
      const mockResult = { data: [{ id: 1 }], totalCount: 1 };

      aiService.embedSearchQuery.mockResolvedValue(mockVector);
      repository.searchHybrid.mockResolvedValue(mockResult as any);

      const result = await service.getTrends({
        search: '  NestJS  ', // 공백 제거 검증
        page: 2,
        limit: 10,
      });

      expect(aiService.embedSearchQuery).toHaveBeenCalledWith('NestJS');
      expect(repository.searchHybrid).toHaveBeenCalledWith({
        page: 2,
        limit: 10,
        search: 'NestJS',
        source: 'ALL',
        isNew: false,
        vector: mockVector,
      });
      expect(repository.searchKeyword).not.toHaveBeenCalled();
      expect(result.meta.totalPages).toBe(1);
    });

    it('검색어가 존재하지만 AI 벡터 결과가 없거나 빈 배열이면 searchKeyword를 호출해야 한다', async () => {
      const mockResult = { data: [{ id: 2 }], totalCount: 5 };

      aiService.embedSearchQuery.mockResolvedValue([]); // 빈 벡터
      repository.searchKeyword.mockResolvedValue(mockResult as any);

      const result = await service.getTrends({ search: 'Redis' });

      expect(aiService.embedSearchQuery).toHaveBeenCalledWith('Redis');
      expect(repository.searchKeyword).toHaveBeenCalledWith({
        page: 1,
        limit: 5,
        search: 'Redis',
        source: 'ALL',
        isNew: false,
      });
      expect(repository.searchHybrid).not.toHaveBeenCalled();
      expect(result.meta.totalPages).toBe(1);
    });

    it('처리 중 에러 발생 시 InternalServerErrorException을 던져야 한다', async () => {
      repository.listTrends.mockRejectedValue(new Error('DB 에러'));

      await expect(service.getTrends({})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getUniqueSources', () => {
    it('성공: 고유 출처 목록을 반환해야 한다', async () => {
      const mockSources = ['dev.to', 'geeknews', 'stackoverflow'];
      repository.findUniqueSources.mockResolvedValue(mockSources);

      const result = await service.getUniqueSources();

      expect(result).toEqual(mockSources);
      expect(repository.findUniqueSources).toHaveBeenCalledTimes(1);
    });

    it('실패: InternalServerErrorException을 던져야 한다', async () => {
      repository.findUniqueSources.mockRejectedValue(new Error('DB 에러'));

      await expect(service.getUniqueSources()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getTrendById', () => {
    it('성공: ID에 해당하는 아티클 단건을 반환해야 한다', async () => {
      const mockArticle = { id: 1, title: '단건 테스트' };
      repository.findById.mockResolvedValue(mockArticle as any);

      const result = await service.getTrendById(1);

      expect(result).toEqual(mockArticle);
      expect(repository.findById).toHaveBeenCalledWith(1);
    });

    it('아티클이 존재하지 않을 경우 NotFoundException을 던져야 한다', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getTrendById(999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('DB 접근 중 원인 불명의 에러 발생 시 InternalServerErrorException을 던져야 한다', async () => {
      repository.findById.mockRejectedValue(new Error('DB 다운'));

      await expect(service.getTrendById(1)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});