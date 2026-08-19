import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../ai/ai.service';
import { chunkArray } from '../../common/utils/array.util';
import { sanitizeAndFilter } from '../../common/utils/text.util';
import { delaySeconds } from '../../common/utils/time.util';
import { TechTrendRepository } from '../repositories/tech-trend.repository';
import { Article, ArticleDetails, IArticleScraper, SavedArticleInfo, ScrapeJobResult } from '../interfaces/scraper.interface';
import { FinalSummaryResult } from 'ai/interfaces/ai.interface';
import { DevToScraper } from '../scrapers/devto.scraper';
import { GeekNewsScraper } from '../scrapers/geek-news.scraper';
import { StackOverflowScraper } from '../scrapers/stackoverflow.scraper';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RedisService } from 'redis/redis.service';

interface SummarizedArticle {
  article: Article;
  articleDetails: ArticleDetails;
  summary: FinalSummaryResult;
}

interface EmbeddedArticle extends SummarizedArticle {
  embeddingVector: number[];
}

@Injectable()
export class TrendsPipelineService {
  private readonly logger = new Logger(TrendsPipelineService.name);

  private readonly TARGET_SAVE_COUNT: number;
  private readonly BATCH_SIZE: number;
  private readonly REDIS_LOCK_TTL_MS: number;
  private readonly AI_DELAY_SECONDS: number;
  private readonly TEXT_SNIPPET_LENGTH: number;
  private readonly TEXT_CONTENT_LENGTH: number;

  private readonly scraperMap: Map<string, IArticleScraper>;

  constructor(
    @InjectQueue('trend-scraper-queue')
    private readonly scraperQueue: Queue,
    private readonly aiService: AiService,
    private readonly techTrendRepository: TechTrendRepository,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly devToScraper: DevToScraper,
    private readonly geekNewsScraper: GeekNewsScraper,
    private readonly stackOverflowScraper: StackOverflowScraper,
  ) {
    this.TARGET_SAVE_COUNT = Number(this.configService.get('SCRAPER_TARGET_SAVE_COUNT', 5));
    this.BATCH_SIZE = Number(this.configService.get('SCRAPER_BATCH_SIZE', 10));
    this.REDIS_LOCK_TTL_MS = Number(this.configService.get('SCRAPER_REDIS_LOCK_TTL_MS', 600000));
    this.AI_DELAY_SECONDS = Number(this.configService.get('SCRAPER_AI_DELAY_SECONDS', 3));
    this.TEXT_SNIPPET_LENGTH = Number(this.configService.get('SCRAPER_TEXT_SNIPPET_LENGTH', 600));
    this.TEXT_CONTENT_LENGTH = Number(this.configService.get('SCRAPER_TEXT_CONTENT_LENGTH', 5000));

    this.scraperMap = new Map<string, IArticleScraper>([
      [this.devToScraper.sourceName, this.devToScraper],
      [this.geekNewsScraper.sourceName, this.geekNewsScraper],
      [this.stackOverflowScraper.sourceName, this.stackOverflowScraper],
    ]);
  }

  // 스크래들을 큐에 등록
  public async dispatchAllScrapersToQueue(): Promise<void> {
    for (const sourceName of this.scraperMap.keys()) {
      // 1차 수동락
      const lockKey = `lock:scraper:${sourceName}`;
      const lockValue = await this.redisService.acquireLock({
        key: lockKey,
        ttlMs: this.REDIS_LOCK_TTL_MS,
      });

      if (!lockValue) {
        this.logger.warn(`[Queue] ${sourceName} 작업이 이미 진행 중입니다. 중복 요청 무시.`);
        continue;
      }

      // 2차 자동락
      const jobId = sourceName;
      await this.scraperQueue.add(
        'scrape-articles',
        { sourceName, lockValue },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: { count: 50 },
        },
      );

      this.logger.log(`[Queue] ${sourceName} 작업 신규 등록 완료 (jobId: ${jobId})`);
    }
  }

  // Worker가 큐에서 작업을 꺼내어 실행할 때 호출
  public async executeScraperByName(sourceName: string): Promise<ScrapeJobResult> {
    const scraper = this.scraperMap.get(sourceName);
    if (!scraper) {
      throw new Error(`[Pipeline] 등록되지 않은 스크래퍼 소스입니다: ${sourceName}`);
    }

    this.logger.log(`[Pipeline] ${sourceName} 스크래핑 파이프라인 시작`);
    return await this.processSource(scraper);
  }

  // 스크래퍼 단위 처리
  private async processSource(scraper: IArticleScraper): Promise<ScrapeJobResult> {
    let totalSavedCount = 0;
    const savedArticles: SavedArticleInfo[] = [];

    this.logger.log(`[Pipeline] ${scraper.sourceName} 수집 시작 | target=${this.TARGET_SAVE_COUNT}`);

    try {
      // 외부 소스에서 아티클 목록 수집
      const articles = await scraper.getArticles();
      if (articles.length === 0) {
        this.logger.warn(`[Pipeline] ${scraper.sourceName} 수집 결과 없음`);
        return { sourceName: scraper.sourceName, savedCount: 0, savedArticles: [] };
      }

      // 이미 DB에 존재하는 아티클 제거
      const newArticles = await this.excludeExistingArticles(
        articles,
        scraper.sourceName,
      );

      if (newArticles.length === 0) {
        this.logger.warn(`[Pipeline] ${scraper.sourceName} 신규 아티클 없음`);
        return { sourceName: scraper.sourceName, savedCount: 0, savedArticles: [] };
      }

      // 배치 단위 처리
      const batches = chunkArray(newArticles, this.BATCH_SIZE);

      for (const batch of batches) {
        if (totalSavedCount >= this.TARGET_SAVE_COUNT) {
          this.logger.log(`[Pipeline] ${scraper.sourceName} 목표 수량 달성 | saved=${totalSavedCount}`);
          break;
        }

        const remainingQuota = this.TARGET_SAVE_COUNT - totalSavedCount;

        const batchResult = await this.processBatch(batch, scraper, remainingQuota);

        totalSavedCount += batchResult.savedCount;
        savedArticles.push(...batchResult.savedArticles);
      }

      this.logger.log(`[Pipeline] ${scraper.sourceName} 처리 완료 | saved=${totalSavedCount}/${this.TARGET_SAVE_COUNT}`);
    } catch (error: any) {
      this.logger.error(`[Pipeline] ${scraper.sourceName} 처리 실패 | error=${error.message}`, error.stack);
      throw error;
    }

    return {
      sourceName: scraper.sourceName,
      savedCount: totalSavedCount,
      savedArticles,
    };
  }

  // 배치 단위 처리
  private async processBatch(
    batch: Article[],
    scraper: IArticleScraper,
    limit: number,
  ): Promise<{ savedCount: number; savedArticles: SavedArticleInfo[] }> {
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
      return { savedCount: 0, savedArticles: [] };
    }

    // AI 가치 평가
    const valuableArticles = await this.selectValuableArticles({
      articles: validArticles,
      articleDetailsMap,
    });

    if (valuableArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] 가치 평가 통과 아티클 없음`);
      return { savedCount: 0, savedArticles: [] };
    }

    // AI 요약
    const summarizedArticles = await this.summarizeArticles({
      articles: valuableArticles,
      articleDetailsMap,
      limit,
    });

    if (summarizedArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] 요약 완료 아티클 없음`);
      return { savedCount: 0, savedArticles: [] };
    }

    // AI 임베딩
    const embeddedArticles = await this.generateEmbeddingsForArticles(summarizedArticles);

    if (embeddedArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] 임베딩 처리 결과 없음`);
      return { savedCount: 0, savedArticles: [] };
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
    const articleDetailsMap = new Map<string, ArticleDetails>();

    for (const id of articleIds) {
      const details = await scraper.getArticleDetails(id);

      if (details?.content) {
        articleDetailsMap.set(id, details);
      }
    }

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
        this.TEXT_SNIPPET_LENGTH,
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
              this.TEXT_CONTENT_LENGTH,
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
        await delaySeconds(this.AI_DELAY_SECONDS);
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

    if (articles.length === 0) return [];

    try {
      const embeddingTexts = articles.map((article) =>
        this.buildEmbeddingText(article.summary)
      );

      const embeddingVectors = await this.aiService.vectorEmbeddingWithAi({
        texts: embeddingTexts,
        taskType: 'RETRIEVAL_DOCUMENT',
      });

      if (articles.length !== embeddingVectors.length) {
        throw new Error(`[Pipeline] 임베딩 개수 불일치! (요청: ${articles.length}개, 응답: ${embeddingVectors.length}개)`);
      }

      return articles.map((article, index) => ({
        ...article,
        embeddingVector: embeddingVectors[index],
      }));
    } catch (error: any) {
      this.logger.error(`[Pipeline] 임베딩 생성 실패 | error=${error.message}`, error.stack);
      throw error;
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
  private async saveTrends(articles: EmbeddedArticle[]): Promise<{
    savedCount: number;
    savedArticles: SavedArticleInfo[];
  }> {
    let savedCount = 0;
    const savedArticles: SavedArticleInfo[] = [];

    for (const item of articles) {
      try {
        const savedEntity = await this.techTrendRepository.saveTrend({
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
        savedArticles.push({
          id: savedEntity.id,
          sourceId: savedEntity.source_id,
          title: savedEntity.title,
          url: savedEntity.link_url,
        });
      } catch (error: any) {
        this.logger.error(
          `[Pipeline] DB 저장 실패 | source=${item.article.source}, articleId=${item.article.id}, error=${error.message}`,
          error.stack,
        );
      }
    }

    this.logger.log(`[Pipeline] DB 저장 완료 | saved=${savedCount}/${articles.length}`);

    return { savedCount, savedArticles };
  }
}
