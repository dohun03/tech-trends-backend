// src/api/api.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechTrend } from '../database/entities/tech-trend.entity';

@Injectable()
export class ApiService {
  constructor(
    @InjectRepository(TechTrend)
    private readonly techTrendRepository: Repository<TechTrend>,
  ) {}

  async getTrends(query: {
    page?: number;
    limit?: number;
    search?: string;
    source?: string;
    sort?: 'ASC' | 'DESC';
  }) {
    // 파라미터 기본값 정제
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 3;
    const search = query.search || '';
    const source = query.source || 'ALL';
    const sort = query.sort === 'ASC' ? 'ASC' : 'DESC';

    const queryBuilder = this.techTrendRepository.createQueryBuilder('trend');

    if (source !== 'ALL') {
      queryBuilder.andWhere('trend.source = :source', { source });
    }

    // 검색 조건 추가 (제목 or 태그 매칭)
    if (search) {
      queryBuilder.andWhere(
        '(trend.title LIKE :search OR trend.technical_tags LIKE :search)',
        { search: `%${search}%` },
      );
    }

    // 정렬 및 페이지네이션 설계
    queryBuilder
      .orderBy('trend.created_at', sort)
      .addOrderBy('trend.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    // 조회 실행
    const [data, totalItems] = await queryBuilder.getManyAndCount();

    // 메타데이터 조립 및 반환
    const totalPages = Math.ceil(totalItems / limit);

    return {
      data,
      meta: {
        totalItems,
        itemCount: data.length,
        itemsPerPage: limit,
        totalPages,
        currentPage: page,
      },
    };
  }
}