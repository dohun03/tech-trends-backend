import { Injectable, Logger, InternalServerErrorException, NotFoundException, HttpException } from '@nestjs/common';
import { AiService } from 'ai/ai.service';
import { GetTrendsQueryDto } from './dto/get-trends-query.dto';
import { TechTrendRepository } from './repositories/tech-trend.repository';

@Injectable()
export class TrendsQueryService {
  private readonly logger = new Logger(TrendsQueryService.name);

  constructor(
    private readonly techTrendRepository: TechTrendRepository,
    private readonly aiService: AiService,
  ) {}

  async getTrends(query: GetTrendsQueryDto) {
    try {
      const {
        page = 1,
        limit = 5,
        search = '',
        source = 'ALL',
        isNew = false,
        sort = 'DESC',
      } = query;

      // 검색어가 있으면 검색 흐름으로 진입
      if (search.trim()) {
        return await this.searchTrends({
          page,
          limit,
          search: search.trim(),
          source,
          isNew,
        });
      }

      // 검색어가 없으면 일반 목록 조회
      return await this.listTrends({
        page,
        limit,
        source,
        isNew,
        sort,
      });
    } catch (error) {
      this.logger.error(`[getTrends] 데이터 조회 중 에러 발생: ${error}`);
      throw new InternalServerErrorException('트렌드 데이터를 불러오는 중 서버 오류가 발생했습니다.');
    }
  }

  // 일반 목록 조회
  private async listTrends(query: {
    page: number;
    limit: number;
    source: string;
    isNew: boolean;
    sort: 'ASC' | 'DESC';
  }) {
    const result = await this.techTrendRepository.listTrends(query);

    return {
      data: result.data,
      meta: {
        totalCount: result.totalCount,
        totalPages: Math.ceil(result.totalCount / query.limit),
        itemsPerPage: query.limit,
        currentPage: query.page,
      },
    };
  }

  // 검색 분기 처리
  private async searchTrends(query: {
    page: number;
    limit: number;
    search: string;
    source: string;
    isNew: boolean;
  }) {
    const vector = await this.aiService.embedSearchQuery(query.search);

    // 벡터 검색 결과가 있으면 하이브리드 검색, 없으면 키워드로만 검색
    const result = vector && vector.length > 0
      ? await this.techTrendRepository.searchHybrid({ ...query, vector })
      : await this.techTrendRepository.searchKeyword(query);

    return {
      data: result.data,
      meta: {
        totalCount: result.totalCount,
        totalPages: Math.ceil(result.totalCount / query.limit),
        itemsPerPage: query.limit,
        currentPage: query.page,
      },
    };
  }

  async getUniqueSources(): Promise<string[]> {
    try {
      return await this.techTrendRepository.findUniqueSources();
    } catch (error) {
      this.logger.error(`[getUniqueSources] 소스 목록 조회 에러: ${error}`);
      throw new InternalServerErrorException('출처 목록을 불러오지 못했습니다.');
    }
  }

  async getTrendById(id: number) {
    try {
      const article = await this.techTrendRepository.findById(id);
      
      if (!article) {
        throw new NotFoundException(`ID가 ${id}인 아티클을 찾을 수 없습니다.`);
      }
      return article;

    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`[getTrendById] 단건 조회 에러 (ID: ${id}): ${error}`);
      throw new InternalServerErrorException(
        '아티클 상세 정보를 불러오는 중 에러가 발생했습니다.',
      );
    }
  }
}