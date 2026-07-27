import { Injectable, Logger } from '@nestjs/common';
import { DevToScraper } from './scrapers/devto.scraper';
import { AiService } from 'ai/ai.service';
import { chunkArray } from 'common/utils/array.util';
import { sanitizeAndFilter } from 'common/utils/text.util';
import { delaySeconds } from 'common/utils/time.util';
import { TechTrendRepository } from './repositories/tech-trend.repository';

// 파이프라인 데이터 타입 정의 (데이터 변환 흐름 명확화)
interface FinalSummaryResult {
  title: string;
  short_summary: string[];
  long_summary: string;
  tags: string | null;
}

interface DevToArticle {
  id: number;
  title: string;
  url: string;
  created_at: string | Date;
}

interface SummarizedArticle {
  article: DevToArticle;
  summary: FinalSummaryResult;
}

interface EmbeddedArticle extends SummarizedArticle {
  embeddingVector: number[] | null;
}

interface ProcessBatchParams {
  batch: DevToArticle[];
  limit: number;
  currentSavedCount: number;
}

interface SummarizeArticlesParams {
  articles: DevToArticle[];
  contentMap: Map<number, string>;
  limit: number;
  currentSavedCount: number;
}

@Injectable()
export class TrendsPipelineService {
  private readonly logger = new Logger(TrendsPipelineService.name);

  private isProcessing = false;
  private readonly TARGET_SAVE_COUNT = 10;
  private readonly BATCH_SIZE = 10;
  private readonly MIN_REACTIONS = 10;
  private readonly MIN_COMMENTS = 1;

  constructor(
    private readonly devToScraper: DevToScraper,
    private readonly aiService: AiService,
    private readonly techTrendRepository: TechTrendRepository,
  ) {}

  // [메인 파이프라인]
  async collectAndProcessTrends() {
    if (this.isProcessing) {
      this.logger.warn('[Pipeline] 이미 데이터 수집 파이프라인이 실행 중입니다. 중복 실행을 스킵합니다.');
      return;
    }

    this.isProcessing = true;
    let savedCount = 0;
    this.logger.log(`[Pipeline] 트렌드 수집 파이프라인 시작 | targetCount=${this.TARGET_SAVE_COUNT}`);

    try {
      // 외부 데이터 수집
      const rawArticles = await this.devToScraper.getTrendingArticles({
        minReactions: this.MIN_REACTIONS,
        minComments: this.MIN_COMMENTS,
      });
      if (rawArticles.length === 0) {
        this.logger.warn('[Pipeline] 조건을 만족하는 트렌딩 글이 없습니다. | action=terminate');
        return;
      }

      // 내부 DB 중복 검증
      const filteredArticles = await this.excludeExistingArticles(rawArticles);
      if (filteredArticles.length === 0) {
        this.logger.warn('[Pipeline] 수집된 모든 글이 이미 DB에 존재합니다. | action=terminate');
        return;
      }

      // 배치 단위 프로세스 시작
      const batches = chunkArray(filteredArticles, this.BATCH_SIZE);

      for (const batch of batches) {
        if (savedCount >= this.TARGET_SAVE_COUNT) {
          this.logger.log(`[Pipeline] 목표 수량 달성 조기 종료 | target=${this.TARGET_SAVE_COUNT}, current=${savedCount}`);
          break;
        }

        const limit = this.TARGET_SAVE_COUNT - savedCount;
        
        const insertedCount = await this.processBatch({
          batch,
          limit,
          currentSavedCount: savedCount
        });

        savedCount += insertedCount;
      }
    } catch (error: any) {
      this.logger.error(`[Pipeline] 파이프라인 처리 중 오류 발생 | error=${error.message}`, error.stack);
    } finally {
      this.isProcessing = false;
      this.logger.log(`[Pipeline] 트렌드 수집 파이프라인 종료 | totalSaved=${savedCount}`);
    }
  }

  // [배치 단위 파이프라인]
  private async processBatch(params: ProcessBatchParams): Promise<number> {
    const { batch, limit, currentSavedCount } = params;

    // 본문 스크래핑
    const articleIds = batch.map((a) => a.id);
    const contentMap = await this.fetchBatchContents(articleIds);
    const validArticles = batch.filter((a) => contentMap.has(a.id));
    if (validArticles.length === 0) {
      this.logger.warn(`[Pipeline] 배치 내 유효 본문 없음 스킵`);
      return 0;
    }

    // AI 가치 평가
    const valuableIds = await this.evaluateArticlesWithAi(validArticles, contentMap);
    const targetArticles = validArticles.filter((a) => valuableIds.includes(a.id));
    if (targetArticles.length === 0) {
      this.logger.warn(`[Pipeline] AI 가치 평가를 통과된 항목 없음 스킵 | action=skip`);
      return 0;
    }
    
    // AI 본문 요약
    const summarizedArticles = await this.summarizeArticles({
      articles: targetArticles,
      contentMap,
      limit,
      currentSavedCount,
    });
    if (summarizedArticles.length === 0) {
      this.logger.warn('[Pipeline] AI 요약된 항목 없음 스킵 | action=skip');
      return 0;
    }

    // AI 벡터 임베딩 생성
    const embeddedArticles = await this.generateEmbeddings(summarizedArticles);
    if (embeddedArticles.length === 0) {
      this.logger.warn('[Pipeline] AI 임베딩 항목 없음 스킵 | action=skip');
      return 0;
    }

    // DB 저장
    return await this.saveTrends(embeddedArticles);
  }

  // === 세부 기능 메서드 모음 ===
  // DB 중복 필터링
  private async excludeExistingArticles(articles: any[]): Promise<any[]> {
    const sourceIds = articles.map((a) => String(a.id));
    const existingSet = await this.techTrendRepository.findExistingSourceIds('dev.to', sourceIds);
    const filtered = articles.filter((a) => !existingSet.has(String(a.id)));
    
    this.logger.log(`[Pipeline] DB 중복 검증 완료 | raw=${articles.length}, new=${filtered.length}`);

    return filtered;
  }

  // 본문 병렬 스크래핑
  private async fetchBatchContents(articleIds: number[]): Promise<Map<number, string>> {
    this.logger.log(`[Scraper:DevTo] 본문 병렬 스크래핑 시작 | idsCount=${articleIds.length}`);
    const contentMap = new Map<number, string>();

    const promises = articleIds.map(async (id) => {
      const content = await this.devToScraper.getArticleContent(id);
      return { id, content };
    });

    const results = await Promise.allSettled(promises);
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value.content) {
        contentMap.set(result.value.id, result.value.content);
      }
    });

    this.logger.log(`[Scraper:DevTo] 본문 병렬 스크래핑 완료 | successCount=${contentMap.size}`);

    return contentMap;
  }

  // AI 가치 평가
  private async evaluateArticlesWithAi(articles: any[], contentMap: Map<number, string>): Promise<number[]> {
    const batchPayload = articles.map((a) => ({
      id: a.id,
      title: a.title,
      snippet: sanitizeAndFilter(contentMap.get(a.id) || '', 800),
    }));

    const valuableIds = await this.aiService.filterBatchWithAi({ items: batchPayload });
    this.logger.log(`[Pipeline] AI 가치 평가 완료 | valid=${articles.length}, selected=${valuableIds.length}`);
    
    return valuableIds;
  }

  // AI 요약
  private async summarizeArticles(params: SummarizeArticlesParams): Promise<SummarizedArticle[]> {
    const { articles, contentMap, limit, currentSavedCount } = params;
    const summaryResults: SummarizedArticle[] = [];

    for (const article of articles) {
      if (summaryResults.length >= limit) break;

      const content = contentMap.get(article.id);
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

        const progress = currentSavedCount + summaryResults.length;
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
          source: 'dev.to',
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
          `[Pipeline] 개별 아티클 DB 저장 실패 | articleId=${item.article.id}, error=${error.message}`,
        );
      }
    }

    this.logger.log(`[Pipeline] DB 저장 완료 | insertCount=${savedCount}/${articles.length}`);

    return savedCount;
  }
}