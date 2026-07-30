import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { chunkArray } from '../common/utils/array.util';
import { sanitizeAndFilter } from '../common/utils/text.util';
import { delaySeconds } from '../common/utils/time.util';
import { TechTrendRepository } from './repositories/tech-trend.repository';
import { BaseArticle, IArticleScraper } from './interfaces/scraper.interface';
import { FinalSummaryResult } from 'ai/interfaces/ai.interface';
import { DevToScraper } from './scrapers/devto.scraper';
import { GeekNewsScraper } from './scrapers/geek-news.scraper';

// 서비스 내부 전용 타입 정의 (외부 파일 분리 필요 없음)
interface SummarizedArticle {
  article: BaseArticle;
  summary: FinalSummaryResult;
}

interface EmbeddedArticle extends SummarizedArticle {
  embeddingVector: number[] | null;
}

interface ProcessBatchParams {
  batch: BaseArticle[];
  remainingQuota: number;
  totalSavedCount: number;
  scraper: IArticleScraper;
}

interface SummarizeArticlesParams {
  articles: BaseArticle[];
  articleContentMap: Map<string, string>;
  remainingQuota: number;
  totalSavedCount: number;
}

@Injectable()
export class TrendsPipelineService {
  private readonly logger = new Logger(TrendsPipelineService.name);

  private isProcessing = false;
  private readonly TARGET_SAVE_COUNT = 10;
  private readonly BATCH_SIZE = 10;

  private scrapers: IArticleScraper[];

  constructor(
    private readonly aiService: AiService,
    private readonly techTrendRepository: TechTrendRepository,
    private readonly devToScraper: DevToScraper,
    private readonly geekNewsScraper: GeekNewsScraper,
  ) {
    // 스크래퍼 배열 등록
    this.scrapers = [this.devToScraper, this.geekNewsScraper];
  }

  // [메인 파이프라인]
  async collectAndProcessTrends() {
    if (this.isProcessing) {
      this.logger.warn('[Pipeline] 이미 데이터 수집 파이프라인이 실행 중입니다. 중복 실행을 스킵합니다.');
      return;
    }
    
    this.isProcessing = true;

    // 스크래퍼별로 순회 실행
    try {
      for (const scraper of this.scrapers) {
        await this.processSource(scraper);
      }
    } catch (error: any) {
      this.logger.error(`[Pipeline] 전체 파이프라인 처리 중 오류 발생 | error=${error.message}`, error.stack);
    } finally {
      this.isProcessing = false;
      this.logger.log(`[Pipeline] 모든 트렌드 수집 파이프라인 종료`);
    }
  }

  // [개별 플랫폼 처리 로직]
  private async processSource(scraper: IArticleScraper) {
    let totalSavedCount = 0;
    this.logger.log(`[Pipeline] ${scraper.sourceName} 트렌드 수집 시작 | targetCount=${this.TARGET_SAVE_COUNT}`);

    try {
      // 1. 외부 데이터 수집 (스크래퍼의 범용 메서드 호출)
      const trendingArticles = await scraper.getTrendingArticles();

      if (!trendingArticles || trendingArticles.length === 0) {
        this.logger.warn(`[Pipeline] ${scraper.sourceName} - 조건을 만족하는 트렌딩 글이 없습니다. | action=terminate`);
        return;
      }

      // 2. 내부 DB 중복 검증 (source 필드 활용)
      const filteredArticles = await this.excludeExistingArticles(trendingArticles, scraper.sourceName);
      if (filteredArticles.length === 0) {
        this.logger.warn(`[Pipeline] ${scraper.sourceName} - 수집된 모든 글이 이미 DB에 존재합니다. | action=terminate`);
        return;
      }

      // 3. 배치 단위 프로세스 시작
      const batches = chunkArray(filteredArticles, this.BATCH_SIZE);

      for (const batch of batches) {
        if (totalSavedCount >= this.TARGET_SAVE_COUNT) {
          this.logger.log(`[Pipeline] ${scraper.sourceName} - 목표 수량 달성 조기 종료 | target=${this.TARGET_SAVE_COUNT}, current=${totalSavedCount}`);
          break;
        }

        const remainingQuota = this.TARGET_SAVE_COUNT - totalSavedCount;
        
        const insertedCount = await this.processBatch({
          batch,
          remainingQuota,
          totalSavedCount,
          scraper
        });

        totalSavedCount += insertedCount;
      }
    } catch (error: any) {
      this.logger.error(`[Pipeline] ${scraper.sourceName} 파이프라인 처리 중 오류 발생 | error=${error.message}`);
    }
  }

  // [배치 단위 파이프라인]
  private async processBatch(params: ProcessBatchParams): Promise<number> {
    const { batch, remainingQuota, totalSavedCount, scraper } = params;

    // 본문 스크래핑
    const articleIds = batch.map((a) => a.id);
    const articleContentMap = await this.fetchBatchContents(scraper, articleIds);
    const validArticles = batch.filter((a) => articleContentMap.has(a.id));
    if (validArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] 배치 내 유효 본문 없음 스킵`);
      return 0;
    }

    // AI 가치 평가
    const valuableIds = await this.evaluateArticlesWithAi(validArticles, articleContentMap);
    const valuableArticles = validArticles.filter((a) => valuableIds.includes(a.id));
    if (valuableArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] AI 가치 평가를 통과된 항목 없음 스킵 | action=skip`);
      return 0;
    }
    
    // AI 본문 요약
    const summarizedArticles = await this.summarizeArticles({
      articles: valuableArticles,
      articleContentMap,
      remainingQuota,
      totalSavedCount,
    });
    
    if (summarizedArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] AI 요약된 항목 없음 스킵 | action=skip`);
      return 0;
    }

    // AI 벡터 임베딩 생성
    const embeddedArticles = await this.generateEmbeddings(summarizedArticles);
    if (embeddedArticles.length === 0) {
      this.logger.warn(`[Pipeline] [${scraper.sourceName}] AI 임베딩 항목 없음 스킵 | action=skip`);
      return 0;
    }

    // DB 저장
    return await this.saveTrends(embeddedArticles);
  }



  // [ === 하위 세부 기능 메서드 모음 === ]

  // DB 중복 필터링
  private async excludeExistingArticles(articles: BaseArticle[], sourceName: string): Promise<BaseArticle[]> {
    const sourceIds = articles.map((a) => String(a.id));
    const existingSet = await this.techTrendRepository.findExistingSourceIds(sourceName, sourceIds);
    const filtered = articles.filter((a) => !existingSet.has(String(a.id)));
    
    this.logger.log(`[Pipeline] DB 중복 검증 완료 | source=${sourceName}, raw=${articles.length}, new=${filtered.length}`);

    return filtered;
  }

  // 본문 병렬 스크래핑
  private async fetchBatchContents(scraper: IArticleScraper, articleIds: string[]): Promise<Map<string, string>> {
    this.logger.log(`[Scraper:${scraper.sourceName}] 본문 병렬 스크래핑 시작 | idsCount=${articleIds.length}`);
    
    const articleContentMap = new Map<string, string>();

    const promises = articleIds.map(async (id) => {
      const content = await scraper.getArticleContent(id);
      return { id, content };
    });

    const results = await Promise.allSettled(promises);
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value.content) {
        articleContentMap.set(result.value.id, result.value.content);
      }
    });

    this.logger.log(`[Scraper:${scraper.sourceName}] 본문 병렬 스크래핑 완료 | successCount=${articleContentMap.size}`);

    return articleContentMap;
  }

  // AI 가치 평가
  private async evaluateArticlesWithAi(articles: BaseArticle[], articleContentMap: Map<string, string>): Promise<string[]> {
    const batchPayload = articles.map((a) => ({
      id: a.id,
      title: a.title,
      snippet: sanitizeAndFilter(articleContentMap.get(a.id) || '', 800),
    }));

    const valuableIds = await this.aiService.filterBatchWithAi({ items: batchPayload });
    this.logger.log(`[Pipeline] AI 가치 평가 완료 | valid=${articles.length}, selected=${valuableIds.length}`);
    
    return valuableIds.map(String);
  }

  // AI 요약
  private async summarizeArticles(params: SummarizeArticlesParams): Promise<SummarizedArticle[]> {
    const { articles, articleContentMap, remainingQuota, totalSavedCount } = params;
    const summaryResults: SummarizedArticle[] = [];

    for (const article of articles) {
      if (summaryResults.length >= remainingQuota) break;

      const content = articleContentMap.get(article.id);
      if (!content) continue;

      const cleanContent = sanitizeAndFilter(content, 5000);

      try {
        const summary = await this.aiService.summarizeContentWithAi({
          title: article.title,
          content: cleanContent,
        });
        
        if (!summary) {
          this.logger.warn(`[Pipeline] 요약 내용이 없음 | articleId=${article.id}, action=skip`);
          continue;
        }

        summaryResults.push({
          article,
          summary,
        });

        const progress = totalSavedCount + summaryResults.length;
        this.logger.log(`[Pipeline] 아티클 요약 완료 | progress=${progress}/${this.TARGET_SAVE_COUNT}, articleId=${article.id}`);

        await delaySeconds(3);

      } catch (error: any) {
        this.logger.error(`[Pipeline] 요약 중 에러 발생 스킵 | articleId=${article.id}, error=${error.message}`);
      }
    }

    return summaryResults;
  }

  // AI 벡터 임베딩 생성
  private async generateEmbeddings(articles: SummarizedArticle[]): Promise<EmbeddedArticle[]> {
    try {
      this.logger.log(`[Pipeline] 임베딩 생성 시작 | count=${articles.length}`);
      
      const embeddingTexts = articles.map((a) => this.buildEmbeddingText(a.summary));
      const embeddingVectors = await this.aiService.vectorEmbeddingWithAi({
        texts: embeddingTexts,
        taskType: 'RETRIEVAL_DOCUMENT'
      });

      return articles.map((article, index) => ({
        ...article,
        embeddingVector: embeddingVectors[index] || null,
      }));
    } catch (error: any) {
      this.logger.error(`[Pipeline] 임베딩 생성 중 오류 발생 | error=${error.message}`);
      return [];
    }
  }

  // 포맷팅 전용 메서드
  private buildEmbeddingText(summary: FinalSummaryResult): string {
    const tagsStr = summary.tags || '';
    const shortSummaryStr = Array.isArray(summary.short_summary) 
      ? summary.short_summary.join(' ') 
      : '';
    const longSummaryStr = summary.long_summary || '';

    return `[제목]: ${summary.title}\n[태그]: ${tagsStr}\n[요약]: ${shortSummaryStr}\n[상세]: ${longSummaryStr}`;
  }

  // DB 저장
  private async saveTrends(articles: EmbeddedArticle[]): Promise<number> {
    let savedCount = 0;

    for (const item of articles) {
      try {
        await this.techTrendRepository.saveTrend({
          source: item.article.source, // 각 플랫폼의 동적 Source 할당
          source_id: String(item.article.id),
          title: item.summary.title,
          short_summary: item.summary.short_summary,
          long_summary: item.summary.long_summary,
          link_url: item.article.url,
          technical_tags: item.summary.tags,
          embedding: item.embeddingVector,
          created_at: new Date(item.article.created_at),
        });

        savedCount++;
      } catch (error: any) {
        this.logger.error(
          `[Pipeline] 개별 아티클 DB 저장 실패 | source=${item.article.source}, articleId=${item.article.id}, error=${error.message}`,
        );
      }
    }

    this.logger.log(`[Pipeline] DB 저장 완료 | insertCount=${savedCount}/${articles.length}`);

    return savedCount;
  }
}