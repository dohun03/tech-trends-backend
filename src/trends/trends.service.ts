import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DevToScraper } from './scrapers/devto.scraper';
import { TechTrend } from 'database/entities/tech-trend.entity';
import Groq from 'groq-sdk';
import { Cron } from '@nestjs/schedule';

interface BatchEvaluationResult {
  valuable_ids: number[];
}

interface FinalSummaryResult {
  title: string;
  short_summary: string[];
  long_summary: string;
  tags: string | null;
}

@Injectable()
export class TrendsService {
  private readonly logger = new Logger(TrendsService.name);
  private groq: Groq;
  private isProcessing = false;

  private readonly TARGET_COUNT = 10;
  private readonly BATCH_SIZE = 10;
  private readonly MIN_REACTIONS = 10;
  private readonly MIN_COMMENTS = 1;

  constructor(
    private readonly devToScraper: DevToScraper,
    @InjectRepository(TechTrend)
    private readonly techTrendRepository: Repository<TechTrend>,
  ) {
    this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  @Cron('0 1 * * *', { name: 'devto-trends-collector', timeZone: 'Asia/Seoul' })
  async handleDailyTrendsCron() {
    this.logger.log('Cron : 수집 배치 작업을 시작합니다.');
    await this.collectAndProcessTrends();
  }

  // 메인 파이프라인
  async collectAndProcessTrends() {
    if (this.isProcessing) {
      this.logger.warn('이미 수집 파이프라인이 실행 중입니다.');
      return;
    }

    this.isProcessing = true;
    let savedCount = 0;

    try {
      // 100개 글 목록 수집
      const articles = await this.devToScraper.getTrendingArticles({
        minReactions: this.MIN_REACTIONS,
        minComments: this.MIN_COMMENTS,
      });

      if (articles.length === 0) {
        this.logger.warn('조건을 만족하는 글이 없습니다.');
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

      // 10개 단위 배치 분할 (2중 배열)
      const batches = this.chunkArray(filteredArticles, this.BATCH_SIZE);

      // 배치 단위 처리 루프 (목표 개수 채울 때까지)
      for (const batch of batches) {
        if (savedCount >= this.TARGET_COUNT) {
          this.logger.log(`목표 수량(${this.TARGET_COUNT}개) 달성으로 파이프라인을 완료합니다.`);
          break;
        }

        const batchIds = batch.map((a) => a.id);
        const contentMap = await this.fetchBatchContents(batchIds);
        const batchPayload = batch.map((article) => ({
          id: article.id,
          title: article.title,
          snippet: this.sanitizeAndFilter(contentMap.get(article.id) || '', 800),
        }));

        // AI 평가 (가치 있는 글 ID 선정)
        const valuableIds = await this.filterBatchWithAi(batchPayload);
        this.logger.log(`배치 ${batch.length}개 중 AI가 가치 있다고 평가한 글: ${valuableIds.length}개`);

        // 10개 단위 배치 루프 실행
        for (const article of batch) {
          // 10개 이하 / 필터링된 것만 실행
          if (savedCount >= this.TARGET_COUNT) break;
          if (!valuableIds.includes(article.id)) continue;

          // ID별로 원문 추출
          const content = contentMap.get(article.id);
          if (!content) continue;

          // 원본 글 5000자로 자름
          const cleanContent = this.sanitizeAndFilter(content, 5000);

          // AI 요약
          this.logger.log(`AI 요약 시작..`);
          const summary = await this.contentSummaryWithAi(article.title, cleanContent);
          if (!summary) continue;

          // DB 저장
          const entity = this.techTrendRepository.create({
            source: 'dev.to',
            source_id: String(article.id),
            title: summary.title,
            short_summary: summary.short_summary,
            long_summary: summary.long_summary,
            link_url: article.url,
            technical_tags: summary.tags,
            created_at: new Date(article.created_at),
          });
          await this.techTrendRepository.save(entity);

          savedCount++;

          this.logger.log(`저장 완료 [${savedCount}/${this.TARGET_COUNT}]: ${summary.title}`);
          this.logger.log(`2초 뒤 루프 재실행`);

          await this.delaySeconds(2);
        }
      }
    } catch (error) {
      this.logger.error('수집 파이프라인 처리 중 오류 발생', error);
    } finally {
      this.isProcessing = false;
      this.logger.log(`====== 수집 작업 종료 (총 저장: ${savedCount}개) ======`);
    }
  }

  // 글 여러개에 대해 병렬로 본문 스크래핑
  private async fetchBatchContents(articleIds: number[]): Promise<Map<number, string>> {
    this.logger.log(`${articleIds.length}개 글 본문 병렬 수집 시작...`);
    const contentMap = new Map<number, string>();

    const promises = articleIds.map(async (id) => {
      const content = await this.devToScraper.getArticleContent(id);
      return { id, content };
    });

    const results = await Promise.all(promises);
    results.forEach(({ id, content }) => {
      contentMap.set(id, content);
    });

    return contentMap;
  }

  // AI 평가(필터링)
  private async filterBatchWithAi(
    items: Array<{ id: number; title: string; snippet: string }>,
  ): Promise<number[]> {
    const prompt = `
    당신은 백엔드 개발자 시각의 IT 트렌드 큐레이터입니다.
    아래 10개 아티클 목록(제목 및 800자 요약)을 읽고, 백엔드/DevOps/CS/개발기술 측면에서 실무에 도움이 되는 가치 있는 글의 ID만 선택하세요.

    [제외 대상]
    - 수필, 개인 회고, 개발 커리어 고민, 소소한 일상
    - 단순 광고/홍보성 글

    [평가 대상]
    ${JSON.stringify(items, null, 2)}

    [응답 포맷 (JSON)]
    {
      "valuable_ids": [12345, 67890]
    }
    `;

    try {
      const response = await this.groq.chat.completions.create({
        model: 'qwen/qwen3.6-27b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_completion_tokens: 4096,
        reasoning_effort: 'none',
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) return [];

      const parsed: BatchEvaluationResult = JSON.parse(raw);
      return parsed.valuable_ids || [];
    } catch (error: any) {
      this.logger.error(`배치 AI 평가 실패: ${error.message}`);
      return [];
    }
  }

  // AI 요약
  private async contentSummaryWithAi(
    title: string,
    content: string,
  ): Promise<FinalSummaryResult | null> {
    const prompt = `
    당신은 IT 트렌드 전문 에디터입니다.
    제공된 개발 블로그 글을 한국인 백엔드 개발자 시각으로 요약하세요.

    [글 정보]
    - 영문 제목: ${title}
    - 본문 내용: ${content}

    [작성 가이드]
    1. title: 기술 직관적인 한국어 제목
    2. short_summary: 핵심 내용 친근한 존댓말(~해요) 3문장 배열
    3. long_summary: 원문 내용에 따라서 300자~1000자 이상의 상세 마크다운 요약 (구체적인 개념, 기술 스택, 실습, 주요 제약 조건 포함)
    4. tags: 주요 기술 스택 쉼표 구분 문자열 (예: "NestJS, Redis")

    [응답 포맷 (JSON)]
    {
      "title": "가공된 한국어 제목",
      "short_summary": ["문장 1", "문장 2", "문장 3"],
      "long_summary": "마크다운 본문 요약...",
      "tags": "NestJS, TypeORM"
    }
    `;

    try {
      const response = await this.groq.chat.completions.create({
        model: 'qwen/qwen3.6-27b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_completion_tokens: 4096,
        reasoning_effort: 'none',
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      return {
        title: parsed.title || title,
        short_summary: Array.isArray(parsed.short_summary) ? parsed.short_summary : [parsed.short_summary],
        long_summary: parsed.long_summary || '',
        tags: Array.isArray(parsed.tags) ? parsed.tags.join(', ') : parsed.tags || null,
      };
    } catch (error: any) {
      this.logger.error(`단일 AI 요약 생성 실패 (${title}): ${error.message}`);
      return null;
    }
  }

  // 유틸리티 메서드 모음

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private sanitizeAndFilter(markdown: string, limit = 800): string {
    if (!markdown) return '';

    const cleaned = markdown
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/```[\s\S]*?```/g, '[코드 블록 생략]')
      .replace(/<[^>]*>?/gm, '')
      .replace(/\|?\s*:-+:?\s*\|?/g, '')
      .replace(/^-{3,}$/gm, '')
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      .replace(/\n\s*\n+/g, '\n')
      .trim();

    return cleaned.length > limit ? cleaned.substring(0, limit) + '...' : cleaned;
  }

  private delaySeconds(seconds: number) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}