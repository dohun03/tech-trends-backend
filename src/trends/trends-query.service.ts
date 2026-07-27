import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechTrend } from '../trends/entities/tech-trend.entity';
import { AiService } from 'ai/ai.service';
import { GetTrendsQueryDto } from './dto/get-trends-query.dto';

@Injectable()
export class TrendsQueryService {
  private readonly logger = new Logger(TrendsQueryService.name);

  constructor(
    @InjectRepository(TechTrend)
    private readonly techTrendRepository: Repository<TechTrend>,
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

      const sortBy = search ? (query.sortBy || 'relevance') : 'date';
      
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

      // 검색어가 존재하는 경우
      if (search) {
        const queryVector = await this.aiService.embedSearchQuery(search);
        if (!queryVector) {
          return { data: [], meta: { totalCount: 0, totalPages: 0, itemsPerPage: limit, currentPage: page } };
        }

        const vectorString = `[${queryVector.join(',')}]`;
        const DISTANCE_THRESHOLD = 0.33;

        queryBuilder
          .addSelect('trend.embedding <=> :vector', 'distance')
          .setParameter('vector', vectorString)
          .andWhere('trend.embedding IS NOT NULL')
          .andWhere('(trend.embedding <=> :vector) <= :threshold', { threshold: DISTANCE_THRESHOLD });

        // 사용자가 검색 상태에서 명시적으로 'date' 정렬을 선택한 경우
        if (sortBy === 'date') {
          queryBuilder
            .orderBy('trend.created_at', sort)
            .addOrderBy('distance', 'ASC');
        } else {
          // 기본값: 정확도(연관도) 순 정렬 (동점 시 최신순)
          queryBuilder
            .orderBy('distance', 'ASC')
            .addOrderBy('trend.created_at', sort);
        }
      } 
      // 검색어가 없는 경우 (기본 목록)
      else {
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