import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { chunkArray } from '../common/utils/array.util';
import { sanitizeAndFilter } from '../common/utils/text.util';
import { delaySeconds } from '../common/utils/time.util';
import { TechTrendRepository } from './repositories/tech-trend.repository';
import { Article, ArticleDetails, IArticleScraper } from './interfaces/scraper.interface';
import { FinalSummaryResult } from 'ai/interfaces/ai.interface';
import { DevToScraper } from './scrapers/devto.scraper';
import { GeekNewsScraper } from './scrapers/geek-news.scraper';
import { StackOverflowScraper } from './scrapers/stackoverflow.scraper';
import { RedisService } from 'redis/redis.service';

interface SummarizedArticle {
  article: Article;
  articleDetails: ArticleDetails;
  summary: FinalSummaryResult;
}

interface EmbeddedArticle extends SummarizedArticle {
  embeddingVector: number[] | null;
}

@Injectable()
export class TrendsPipelineService {
  private readonly logger = new Logger(TrendsPipelineService.name);
  private readonly TARGET_SAVE_COUNT = 5;
  private readonly BATCH_SIZE = 10;
  private readonly scrapers: IArticleScraper[];

  constructor(
    private readonly aiService: AiService,
    private readonly techTrendRepository: TechTrendRepository,
    private readonly redisService: RedisService,
    private readonly devToScraper: DevToScraper,
    private readonly geekNewsScraper: GeekNewsScraper,
    private readonly stackOverflowScraper: StackOverflowScraper,
  ) {
    this.scrapers = [
      this.devToScraper,
      this.geekNewsScraper,
      this.stackOverflowScraper,
    ];
  }

  // 메인 파이프라인
  async mainProcess(): Promise<void> {
    // 분산 락 생성/체크
    const lockKey = 'lock:pipeline:main';
    const lockTtlMs = 15 * 60 * 1000; // 15분

    const lockValue = await this.redisService.acquireLock({
      key: lockKey,
      ttlMs: lockTtlMs,
    });

    if (!lockValue) {
      this.logger.warn('[Pipeline] 이미 실행 중인 파이프라인이 있어 스킵합니다.');
      return;
    }

    try {
      for (const scraper of this.scrapers) {
        await this.processSource(scraper);
      }
    } catch (error: any) {
      this.logger.error(`[Pipeline] 전체 처리 실패 | error=${error.message}`, error.stack);
    } finally {
      await this.redisService.releaseLock({
        key: lockKey,
        value: lockValue,
      });
      this.logger.log('[Pipeline] 전체 파이프라인 종료 (Lock 안전 해제 완료)');
    }
  }

  // 스크래퍼 단위 처리
  private async processSource(scraper: IArticleScraper): Promise<void> {
    let totalSavedCount = 0;

    this.logger.log(`[Pipeline] ${scraper.sourceName} 수집 시작 | target=${this.TARGET_SAVE_COUNT}`);

    try {
      // 외부 소스에서 아티클 목록 수집
      const articles = await scraper.getArticles();
      if (articles.length === 0) {
        this.logger.warn(`[Pipeline] ${scraper.sourceName} 수집 결과 없음`);
        return;
      }

      // 이미 DB에 존재하는 아티클 제거
      const newArticles = await this.excludeExistingArticles(
        articles,
        scraper.sourceName,
      );

      if (newArticles.length === 0) {
        this.logger.warn(`[Pipeline] ${scraper.sourceName} 신규 아티클 없음`);
        return;
      }

      // 배치 단위 처리
      const batches = chunkArray(newArticles, this.BATCH_SIZE);

      for (const batch of batches) {
        if (totalSavedCount >= this.TARGET_SAVE_COUNT) {
          this.logger.log(`[Pipeline] ${scraper.sourceName} 목표 수량 달성 | saved=${totalSavedCount}`);
          break;
        }

        const remainingQuota = this.TARGET_SAVE_COUNT - totalSavedCount;

        const savedCount = await this.processBatch(
          batch,
          scraper,
          remainingQuota,
        );

        totalSavedCount += savedCount;
      }

      this.logger.log(`[Pipeline] ${scraper.sourceName} 처리 완료 | saved=${totalSavedCount}/${this.TARGET_SAVE_COUNT}`);
    } catch (error: any) {
      this.logger.error(`[Pipeline] ${scraper.sourceName} 처리 실패 | error=${error.message}`, error.stack);
    }
  }

  // 배치 단위 처리
  private async processBatch(
    batch: Article[],
    scraper: IArticleScraper,
    limit: number,
  ): Promise<number> {
    // 본문 확보
    const articleIds = batch.map((article) => String(article.id));

    const articleDetailsMap = await this.fetchBatchDetailsMap(
      scraper,
      articleIds,
    );

    const validArticles = batch.filter((article) =>
      articleDetailsMap.has(String(article.id)),
    );

    if (validArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] 유효 본문 없음`);
      return 0;
    }

    // AI 가치 평가
    const valuableArticles = await this.selectValuableArticles({
      articles: validArticles,
      articleDetailsMap,
    });

    if (valuableArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] 가치 평가 통과 아티클 없음`);
      return 0;
    }

    // AI 요약
    const summarizedArticles = await this.summarizeArticles({
      articles: valuableArticles,
      articleDetailsMap,
      limit,
    });

    if (summarizedArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] 요약 완료 아티클 없음`);
      return 0;
    }

    // AI 임베딩
    const embeddedArticles = await this.generateEmbeddingsForArticles(summarizedArticles);

    if (embeddedArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] 임베딩 처리 결과 없음`);
      return 0;
    }

    // DB 저장
    return this.saveTrends(embeddedArticles);
  }

  // [ 세부 기능 메서드 ]

  // DB 중복 제거
  private async excludeExistingArticles(
    articles: Article[],
    sourceName: string,
  ): Promise<Article[]> {
    const sourceIds = articles.map((article) =>
      String(article.id),
    );

    const existingIds =
      await this.techTrendRepository.findExistingSourceIds(
        sourceName,
        sourceIds,
      );

    const newArticles = articles.filter(
      (article) => !existingIds.has(String(article.id)),
    );

    this.logger.log(`[Pipeline] 중복 검증 완료 | source=${sourceName}, raw=${articles.length}, new=${newArticles.length}`);

    return newArticles;
  }

  // 배치 내 아티클 본문을 병렬로 수집
  private async fetchBatchDetailsMap(
    scraper: IArticleScraper,
    articleIds: string[],
  ): Promise<Map<string, ArticleDetails>> {
    const results = await Promise.allSettled(
      articleIds.map(async (id) => ({
        id,
        details: await scraper.getArticleDetails(id),
      })),
    );

    const articleDetailsMap = new Map<
      string,
      ArticleDetails
    >();

    results.forEach((result) => {
      if (result.status !== 'fulfilled') {
        return;
      }

      const { id, details } = result.value;

      if (details?.content) {
        articleDetailsMap.set(id, details);
      }
    });

    return articleDetailsMap;
  }

  // AI로 가치 있는 아티클만 선별
  private async selectValuableArticles({
    articles,
    articleDetailsMap,
  }: {
    articles: Article[];
    articleDetailsMap: Map<string, ArticleDetails>;
  }): Promise<Article[]> {
    
    const items = articles.map((article) => ({
      id: String(article.id),
      title: article.title,
      snippet: sanitizeAndFilter(
        articleDetailsMap.get(String(article.id))?.content ?? '',
        600,
      ),
    }));

    const valuableIds = new Set((
      await this.aiService.filterBatchWithAi({ items })).map(String)
    );

    const valuableArticles = articles.filter((article) =>
      valuableIds.has(String(article.id)),
    );

    this.logger.log(`[Pipeline] AI 가치 평가 완료 | input=${articles.length}, selected=${valuableArticles.length}`);

    return valuableArticles;
  }

  // 아티클을 순차적으로 요약
  private async summarizeArticles({
    articles,
    articleDetailsMap,
    limit,
  }: {
    articles: Article[];
    articleDetailsMap: Map<string, ArticleDetails>;
    limit: number;
  }): Promise<SummarizedArticle[]> {
    const summarizedArticles: SummarizedArticle[] = [];

    for (const article of articles) {
      if (summarizedArticles.length >= limit) {
        break;
      }

      const details = articleDetailsMap.get(
        String(article.id),
      );

      if (!details?.content) {
        continue;
      }

      try {
        const summary =
          await this.aiService.summarizeContentWithAi({
            title: article.title,
            content: sanitizeAndFilter(
              details.content,
              5000,
            ),
          });

        if (!summary) {
          this.logger.warn(`[Pipeline] 요약 결과 없음 | articleId=${article.id}`);
          continue;
        }

        summarizedArticles.push({
          article,
          articleDetails: details,
          summary,
        });

        this.logger.log(`[Pipeline] 요약 완료 | articleId=${article.id}`);

        // AI API 호출 간격
        await delaySeconds(3);
      } catch (error: any) {
        // 개별 아티클 요약 실패는 다음 아티클로 진행
        this.logger.error(`[Pipeline] 요약 실패 | articleId=${article.id}, error=${error.message}`, error.stack);
      }
    }

    return summarizedArticles;
  }

  // 요약 결과를 임베딩 벡터로 변환
  private async generateEmbeddingsForArticles(articles: SummarizedArticle[]): Promise<EmbeddedArticle[]> {
    this.logger.log(`[Pipeline] 임베딩 생성 시작 | count=${articles.length}`);

    const embeddingTexts = articles.map((article) =>
      this.buildEmbeddingText(article.summary)
    );

    try {
      const embeddingVectors =
        await this.aiService.vectorEmbeddingWithAi({
          texts: embeddingTexts,
          taskType: 'RETRIEVAL_DOCUMENT',
        });

      return articles.map((article, index) => ({
        ...article,
        embeddingVector: embeddingVectors[index] ?? null,
      }));
    } catch (error: any) {
      this.logger.error(`[Pipeline] 임베딩 생성 실패 | error=${error.message}`, error.stack);

      // 임베딩이 없어도 아티클 저장은 계속 진행
      return articles.map((article) => ({
        ...article,
        embeddingVector: null,
      }));
    }
  }

  // 임베딩 생성용 텍스트 구성
  private buildEmbeddingText(summary: FinalSummaryResult): string {
    const tags = Array.isArray(summary.tags)
      ? summary.tags.join(', ')
      : summary.tags ?? '';

    const shortSummary = Array.isArray(
      summary.short_summary,
    )
      ? summary.short_summary.join(' ')
      : summary.short_summary ?? '';

    const longSummary = summary.long_summary ?? '';

    return [
      `[제목]: ${summary.title}`,
      `[태그]: ${tags}`,
      `[요약]: ${shortSummary}`,
      `[상세]: ${longSummary}`,
    ].join('\n');
  }

  // DB 저장
  private async saveTrends(articles: EmbeddedArticle[]): Promise<number> {
    let savedCount = 0;

    for (const item of articles) {
      try {
        await this.techTrendRepository.saveTrend({
          source: item.article.source,
          source_id: String(item.article.id),
          title: item.summary.title,
          short_summary: item.summary.short_summary,
          long_summary: item.summary.long_summary,
          link_url: item.article.url,
          technical_tags: item.summary.tags,
          embedding: item.embeddingVector,
          view_count: item.articleDetails.view_count ?? null,
          like_count: item.articleDetails.like_count ?? null,
          comment_count: item.articleDetails.comment_count ?? null,
          created_at: new Date(item.article.created_at),
        });

        savedCount++;
      } catch (error: any) {
        this.logger.error(
          `[Pipeline] DB 저장 실패 | source=${item.article.source}, articleId=${item.article.id}, error=${error.message}`,
          error.stack,
        );
      }
    }

    this.logger.log(`[Pipeline] DB 저장 완료 | saved=${savedCount}/${articles.length}`);

    return savedCount;
  }
}
