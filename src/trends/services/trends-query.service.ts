import { Injectable, Logger, InternalServerErrorException, NotFoundException, HttpException } from '@nestjs/common';
import { AiService } from 'ai/ai.service';
import { ListTrendsQueryDto } from 'trends/dto/list-trends-query.dto';
import { SearchTrendsQueryDto } from 'trends/dto/search-trends-query.dto';
import { TechTrendRepository } from 'trends/repositories/tech-trend.repository';


@Injectable()
export class TrendsQueryService {
  private readonly logger = new Logger(TrendsQueryService.name);

  constructor(
    private readonly techTrendRepository: TechTrendRepository,
    private readonly aiService: AiService,
  ) {}

  // 일반 목록 조회
  async listTrends(query: ListTrendsQueryDto) {
    try {
      const { page = 1, limit = 5, source = 'ALL', isNew = false, sort = 'DESC' } = query;
      const result = await this.techTrendRepository.listTrends({ page, limit, source, isNew, sort });

      return {
        data: result.data,
        meta: {
          totalCount: result.totalCount,
          totalPages: Math.ceil(result.totalCount / limit),
          itemsPerPage: limit,
          currentPage: page,
        },
      };
    } catch (error) {
      this.logger.error(`[listTrends] 조회 에러: ${error}`);
      throw new InternalServerErrorException('트렌드 목록 조회 중 에러가 발생했습니다.');
    }
  }

  // 검색 분기 처리
  async searchTrends(query: SearchTrendsQueryDto) {
    const { page = 1, limit = 5, search, source = 'ALL', isNew = false } = query;

    const vector = await this.aiService.embedSearchQuery(search.trim());

    const result = vector && vector.length > 0
      ? await this.techTrendRepository.searchHybrid({ page, limit, search: search.trim(), source, isNew, vector })
      : await this.techTrendRepository.searchKeyword({ page, limit, search: search.trim(), source, isNew });

    return {
      data: result.data,
      meta: {
        totalCount: result.totalCount,
        totalPages: Math.ceil(result.totalCount / limit),
        itemsPerPage: limit,
        currentPage: page,
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