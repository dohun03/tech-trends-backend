// src/api/api.service.ts
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechTrend } from '../database/entities/tech-trend.entity';
import { AiService } from 'ai/ai.service';

@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);

  constructor(
    @InjectRepository(TechTrend)
    private readonly techTrendRepository: Repository<TechTrend>,
    private readonly aiService: AiService,
  ) {}

async getTrends(query: {
    page?: number;
    limit?: number;
    search?: string;
    source?: string;
    isNew?: string;
    sort?: 'ASC' | 'DESC';
  }) {
    try {
      const page = Number(query.page) || 1;
      const limit = Number(query.limit) || 5;
      const search = query.search || '';
      const source = query.source || 'ALL';
      const sort = query.sort === 'ASC' ? 'ASC' : 'DESC';
      const isNew = query.isNew === 'true';

      const queryBuilder = this.techTrendRepository.createQueryBuilder('trend')
        .select([
          'trend.id',
          'trend.source',
          'trend.source_id',
          'trend.title',
          'trend.short_summary',
          'trend.long_summary',
          'trend.link_url',
          'trend.technical_tags',
          'trend.created_at',
          'trend.mined_at'
        ]);

      if (source !== 'ALL') {
        queryBuilder.andWhere('trend.source = :source', { source });
      }

      if (isNew) {
        queryBuilder
          .andWhere('trend.mined_at >= CURRENT_DATE')
          .andWhere("trend.mined_at < CURRENT_DATE + INTERVAL '1 day'");
      }

      // 검색 여부에 따른 정렬 분기 처리
      if (search) {
        const queryVector = await this.aiService.embedSearchQuery(search);
        if (!queryVector) {
          return { data: [], meta: { totalCount: 0, totalPages: 0, itemsPerPage: limit, currentPage: page } };
        }

        const vectorString = `[${queryVector.join(',')}]`;
        const DISTANCE_THRESHOLD = 0.45;

        queryBuilder
          .addSelect('trend.embedding <=> :vector', 'distance')
          .setParameter('vector', vectorString)
          .andWhere('trend.embedding IS NOT NULL')
          .andWhere('(trend.embedding <=> :vector) <= :threshold', { threshold: DISTANCE_THRESHOLD })
          .orderBy('distance', 'ASC'); // 유사도 높은 순
      } else {
        // 검색어 없을 시 날짜순 정렬
        queryBuilder
          .orderBy('trend.created_at', sort)
          .addOrderBy('trend.id', 'DESC');
      }

      // 공통 페이지네이션 적용
      queryBuilder
        .skip((page - 1) * limit)
        .take(limit);

      // 쿼리 실행
      const [data, totalCount] = await queryBuilder.getManyAndCount();
      const totalPages = Math.ceil(totalCount / limit);

      return {
        data,
        meta: {
          totalCount,
          totalPages,
          itemsPerPage: limit,
          currentPage: page,
        },
      };

    } catch (error) {
      // 에러 로깅 및 500 에러 처리
      this.logger.error(`[getTrends] 데이터 조회 중 에러 발생: ${error}`);
      throw new InternalServerErrorException('트렌드 데이터를 불러오는 중 서버 오류가 발생했습니다.');
    }
  }

  async getUniqueSources(): Promise<string[]> {
    try {
      const result = await this.techTrendRepository
        .createQueryBuilder('trend')
        .select('DISTINCT trend.source', 'source')
        .getRawMany();

      return result.map(item => item.source).filter(Boolean);
    } catch (error) {
      this.logger.error(`[getUniqueSources] 소스 목록 조회 에러: ${error}`);
      throw new InternalServerErrorException('출처 목록을 불러오지 못했습니다.');
    }
  }
}