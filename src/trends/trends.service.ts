import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DevToScraper } from './scrapers/devto.scraper';
import { TechTrend } from 'database/entities/tech-trend.entity';
import { AiService } from 'ai/ai.service';
import { chunkArray } from 'common/utils/array.util';
import { sanitizeAndFilter } from 'common/utils/text-filter.util';
import { delaySeconds } from 'common/utils/time.util';

interface FinalSummaryResult {
  title: string;
  short_summary: string[];
  long_summary: string;
  tags: string | null;
}

@Injectable()
export class TrendsService {
  private readonly logger = new Logger(TrendsService.name);

  private isProcessing = false;

  private readonly TARGET_COUNT = 5;
  private readonly BATCH_SIZE = 10;
  private readonly MIN_REACTIONS = 10;
  private readonly MIN_COMMENTS = 1;

  constructor(
    private readonly devToScraper: DevToScraper,
    private readonly aiService: AiService,
    @InjectRepository(TechTrend)
    private readonly techTrendRepository: Repository<TechTrend>,
  ) {}

  // 메인 파이프라인
  async collectAndProcessTrends() {
    if (this.isProcessing) {
      this.logger.warn('[Pipeline] 이미 데이터 수집 파이프라인이 실행 중입니다. 중복 실행을 스킵합니다.');
      return;
    }

    this.isProcessing = true;
    let savedCount = 0;
    this.logger.log(`[Pipeline] 트렌드 수집 파이프라인 시작 | targetCount=${this.TARGET_COUNT}`);

    try {
      // 100개 글 목록 수집
      const articles = await this.devToScraper.getTrendingArticles({
        minReactions: this.MIN_REACTIONS,
        minComments: this.MIN_COMMENTS,
      });
      if (articles.length === 0) {
        this.logger.warn('[Pipeline] 조건을 만족하는 귿이 없습니다. | action=terminate');
        return;
      }

      // DB 중복 일괄 필터링
      const sourceIds = articles.map((a) => String(a.id));
      const existingTrends = await this.techTrendRepository.find({
        where: { source_id: In(sourceIds), source: 'dev.to' },
        select: { source_id: true },
      });
      const existingSet = new Set(existingTrends.map((t) => t.source_id));
      const filteredArticles = articles.filter((a) => !existingSet.has(String(a.id)));

      this.logger.log(`[Pipeline] DB 중복 검증 완료 | raw=${articles.length}, new=${filteredArticles.length}`);

      // 10개 단위 배치 분할
      const batches = chunkArray(filteredArticles, this.BATCH_SIZE);

      // 처리 완료된 항목들을 모아둘 임시 배열
      const collectedItems: Array<{
        article: typeof filteredArticles[0];
        summary: FinalSummaryResult;
        embeddingText: string;
      }> = [];

      // 배치 단위 처리 루프 (목표 개수 채울 때까지)
      for (const batch of batches) {
        if (savedCount >= this.TARGET_COUNT) {
          this.logger.log(`[Pipeline] 목표 수량 달성 조기 종료 | target=${this.TARGET_COUNT}, current=${savedCount}`);
          break;
        }

        const batchIds = batch.map((a) => a.id);
        const articleContentMap = await this.fetchBatchContents(batchIds);
        const validBatch = batch.filter((article) => articleContentMap.has(article.id));
        if (validBatch.length === 0) {
          this.logger.warn(`[Pipeline] 배치 내 유효 본문 없음 스킵`);
          continue;
        }

        const batchPayload = batch.map((article) => ({
          id: article.id,
          title: article.title,
          snippet: sanitizeAndFilter(articleContentMap.get(article.id) || '', 800),
        }));

        // AI 평가 (가치 있는 글 ID 선정)
        const valuableIds = await this.aiService.filterBatchWithAi(batchPayload);
        this.logger.log(`[Pipeline] AI 가치 평가 완료 | valid=${validBatch.length}, selected=${valuableIds.length}`);

        // 10개 단위 배치 루프 실행
        for (const article of batch) {
          if (savedCount >= this.TARGET_COUNT) break;
          if (!valuableIds.includes(article.id)) continue;

          // ID별로 원문 추출
          const content = articleContentMap.get(article.id);
          if (!content) continue;

          // 원본 글 5000자로 자름
          const cleanContent = sanitizeAndFilter(content, 5000);

          // AI 요약
          this.logger.log(`AI 요약 시작..`);
          const summary = await this.aiService.summarizeContentWithAi(article.title, cleanContent);
          if (!summary) continue;

          collectedItems.push({
            article,
            summary,
            embeddingText: `제목: ${summary.title}\n태그: ${summary.tags || ''}\n요약: ${summary.short_summary.join(' ')}`,
          });

          savedCount++;
          this.logger.log(`[Pipeline] 아티클 요약 완료 | progress=${savedCount}/${this.TARGET_COUNT}, articleId=${article.id}`);

          await delaySeconds(3);
        }
      }

      if (collectedItems.length === 0) {
        this.logger.warn('[Pipeline] 수집 및 요약된 항목 없음 | action=terminate');
        return;
      }

      this.logger.log(`[Pipeline] 벡터 임베딩 생성 시작 | count=${collectedItems.length}`);
      const embeddingTexts = collectedItems.map((item) => item.embeddingText);
      const embeddingVectors = await this.aiService.vectorEmbeddingWithAi(embeddingTexts);

      // Entity 생성 및 매핑
      const entities: TechTrend[] = [];
      collectedItems.forEach((item, index) => {
        const { article, summary } = item;
        const embeddingVector = embeddingVectors[index] || null;

        const entity = this.techTrendRepository.create({
          source: 'dev.to',
          source_id: String(article.id),
          title: summary.title,
          short_summary: summary.short_summary,
          long_summary: summary.long_summary,
          link_url: article.url,
          technical_tags: summary.tags,
          embedding: embeddingVector,
          created_at: new Date(article.created_at),
        });

        entities.push(entity);
      });

      // 일괄 DB 저장
      if (entities.length > 0) {
        await this.techTrendRepository.save(entities);
        this.logger.log(`[Pipeline] DB 저장 완료 | insertCount=${entities.length}`);
      }

    } catch (error: any) {
      this.logger.error(`[Pipeline] 파이프라인 처리 중 치명적 오류 발생 | error=${error.message}`, error.stack);
    } finally {
      this.isProcessing = false;
      this.logger.log(`[Pipeline] 트렌드 수집 파이프라인 종료 | totalSaved=${savedCount}`);
    }
  }

  // 글 여러개에 대해 병렬로 본문 스크래핑
  private async fetchBatchContents(articleIds: number[]): Promise<Map<number, string>> {
    this.logger.log(`[Scraper:DevTo] 본문 병렬 스크래핑 시작 | idsCount=${articleIds.length}`);
    const articleContentMap = new Map<number, string>();

    const promises = articleIds.map(async (id) => {
      const content = await this.devToScraper.getArticleContent(id);
      return { id, content };
    });

    const results = await Promise.allSettled(promises);
    
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value.content !== null) {
        articleContentMap.set(result.value.id, result.value.content);
      }
    });

    this.logger.log(`[Scraper:DevTo] 본문 병렬 스크래핑 완료 | successCount=${articleContentMap.size}`);

    return articleContentMap;
  }
}