// tech-trends.repository.ts 예시
import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { TechTrend } from '../entities/tech-trend.entity';

@Injectable()
export class TechTrendsRepository extends Repository<TechTrend> {
  constructor(private dataSource: DataSource) {
    super(TechTrend, dataSource.createEntityManager());
  }

  /**
   * 임베딩 벡터값과 가장 유사한 기술 트렌드 N개 조회 (Cosine Distance)
   */
  async searchByEmbedding(queryEmbedding: number[], limit = 5): Promise<TechTrend[]> {
    const vectorString = `[${queryEmbedding.join(',')}]`;

    return this.createQueryBuilder('trend')
      .where('trend.embedding IS NOT NULL')
      .orderBy(`trend.embedding <=> '${vectorString}'::vector`, 'ASC')
      .take(limit)
      .getMany();
  }
}