import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TechTrend } from '../entities/tech-trend.entity';

type SortOrder = 'ASC' | 'DESC';

interface ListTrendsParams {
  page: number;
  limit: number;
  source: string;
  isNew: boolean;
  sort: SortOrder;
}

interface SearchParams {
  page: number;
  limit: number;
  search: string;
  source: string;
  isNew: boolean;
}

interface SearchResult {
  data: any[];
  totalCount: number;
}

@Injectable()
export class TechTrendRepository {
  constructor(
    @InjectRepository(TechTrend)
    private readonly repository: Repository<TechTrend>,
  ) {}

  // 출처 목록 조회
  async findUniqueSources(): Promise<string[]> {
    const rows = await this.repository
      .createQueryBuilder('trend')
      .select('DISTINCT trend.source', 'source')
      .orderBy('trend.source', 'ASC')
      .getRawMany();

    return rows.map((row) => row.source).filter(Boolean);
  }

  // 기본 목록 조회
  async listTrends(params: ListTrendsParams): Promise<SearchResult> {
    const { page, limit, source, isNew, sort } = params;

    const qb = this.repository
      .createQueryBuilder('trend')
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
        'trend.mined_at',
      ]);

    // 출처 필터
    if (source !== 'ALL') {
      qb.andWhere('trend.source = :source', { source });
    }

    // 오늘 수집된 글만 보기
    if (isNew) {
      qb.andWhere('trend.mined_at >= CURRENT_DATE');
      qb.andWhere("trend.mined_at < CURRENT_DATE + INTERVAL '1 day'");
    }

    // 목록은 날짜순
    qb.orderBy('trend.created_at', sort)
      .addOrderBy('trend.id', sort)
      .skip((page - 1) * limit)
      .take(limit);

    const [data, totalCount] = await qb.getManyAndCount();

    return { data, totalCount };
  }

  // 키워드 검색만 수행
  async searchKeyword(params: SearchParams): Promise<SearchResult> {
    const { page, limit, search, source, isNew } = params;
    const offset = (page - 1) * limit;

    const whereClause = `
      WHERE
        ($2::text = 'ALL' OR trend.source = $2::text)
        AND ($3::boolean = false OR (
          trend.mined_at >= CURRENT_DATE
          AND trend.mined_at < CURRENT_DATE + INTERVAL '1 day'
        ))
        AND trend.search_document @@ plainto_tsquery('simple', $1)
    `;

    const dataSql = `
      SELECT
        trend.id,
        trend.source,
        trend.source_id,
        trend.title,
        trend.short_summary,
        trend.long_summary,
        trend.link_url,
        trend.technical_tags,
        trend.created_at,
        trend.mined_at,
        ts_rank(trend.search_document, plainto_tsquery('simple', $1)) AS relevance_score
      FROM tbl_tech_trends trend
      ${whereClause}
      ORDER BY relevance_score DESC, trend.created_at DESC, trend.id DESC
      LIMIT $4 OFFSET $5
    `;

    const countSql = `
      SELECT COUNT(*)::int AS total_count
      FROM tbl_tech_trends trend
      ${whereClause}
    `;

    const dataParams = [search, source, isNew, limit, offset];
    const countParams = [search, source, isNew];

    const [dataRows, countRows] = await Promise.all([
      this.repository.query(dataSql, dataParams),
      this.repository.query(countSql, countParams),
    ]);

    return {
      data: dataRows,
      totalCount: Number(countRows?.[0]?.total_count || 0),
    };
  }

  // 키워드 + 벡터 하이브리드 검색
  async searchHybrid(params: SearchParams & { vector: number[] }): Promise<SearchResult> {
    const { page, limit, search, source, isNew, vector } = params;
    const offset = (page - 1) * limit;

    const candidateLimit = Math.max(20, limit * 3);
    const rrfK = 60;
    const vectorString = `[${vector.join(',')}]`;

    const commonWhere = `
      WHERE
        ($3::text = 'ALL' OR trend.source = $3::text)
        AND ($4::boolean = false OR (
          trend.mined_at >= CURRENT_DATE
          AND trend.mined_at < CURRENT_DATE + INTERVAL '1 day'
        ))
    `;

    // 키워드 후보군
    const keywordSql = `
      SELECT
        trend.id,
        ROW_NUMBER() OVER (
          ORDER BY
            ts_rank(trend.search_document, plainto_tsquery('simple', $1)) DESC,
            trend.created_at DESC,
            trend.id DESC
        ) AS rank
      FROM tbl_tech_trends trend
      ${commonWhere}
        AND trend.search_document @@ plainto_tsquery('simple', $1)
      LIMIT $5
    `;

    // 벡터 후보군
    const vectorSql = `
      SELECT
        trend.id,
        ROW_NUMBER() OVER (
          ORDER BY
            trend.embedding <=> CAST($2 AS vector) ASC,
            trend.created_at DESC,
            trend.id DESC
        ) AS rank
      FROM tbl_tech_trends trend
      ${commonWhere}
        AND trend.embedding IS NOT NULL
      LIMIT $5
    `;

    const dataSql = `
      WITH keyword_ranked AS (
        ${keywordSql}
      ),
      vector_ranked AS (
        ${vectorSql}
      ),
      rrf AS (
        SELECT
          COALESCE(k.id, v.id) AS id,
          COALESCE(1.0 / ($6 + k.rank), 0) +
          COALESCE(1.0 / ($6 + v.rank), 0) AS rrf_score
        FROM keyword_ranked k
        FULL OUTER JOIN vector_ranked v
          ON k.id = v.id
      )
      SELECT
        trend.id,
        trend.source,
        trend.source_id,
        trend.title,
        trend.short_summary,
        trend.long_summary,
        trend.link_url,
        trend.technical_tags,
        trend.created_at,
        trend.mined_at,
        rrf.rrf_score
      FROM rrf
      JOIN tbl_tech_trends trend ON trend.id = rrf.id
      ORDER BY rrf.rrf_score DESC, trend.created_at DESC, trend.id DESC
      LIMIT $7 OFFSET $8
    `;

    const countSql = `
      WITH keyword_ranked AS (
        ${keywordSql}
      ),
      vector_ranked AS (
        ${vectorSql}
      ),
      rrf AS (
        SELECT
          COALESCE(k.id, v.id) AS id
        FROM keyword_ranked k
        FULL OUTER JOIN vector_ranked v
          ON k.id = v.id
      )
      SELECT COUNT(*)::int AS total_count
      FROM rrf
    `;

    const dataParams = [
      search,         // $1
      vectorString,   // $2
      source,         // $3
      isNew,          // $4
      candidateLimit, // $5
      rrfK,           // $6
      limit,          // $7
      offset,         // $8
    ];

    const countParams = [
      search,         // $1
      vectorString,   // $2
      source,         // $3
      isNew,          // $4
      candidateLimit, // $5
    ];

    const [dataRows, countRows] = await Promise.all([
      this.repository.query(dataSql, dataParams),
      this.repository.query(countSql, countParams),
    ]);

    return {
      data: dataRows,
      totalCount: Number(countRows?.[0]?.total_count || 0),
    };
  }

  // DB 중복 검증용 source_id 조회
  async findExistingSourceIds(source: string, sourceIds: string[]): Promise<Set<string>> {
    if (sourceIds.length === 0) return new Set();

    const rows = await this.repository.find({
      where: {
        source,
        source_id: In(sourceIds),
      },
      select: {
        source_id: true,
      },
    });

    return new Set(rows.map((row) => row.source_id));
  }

  // DB 저장
  async saveTrend(data: Partial<TechTrend>): Promise<TechTrend> {
    return this.repository.save(this.repository.create(data));
  }
}