import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DevToScraper } from './scrapers/devto.scraper';
import { TechTrend } from 'database/entities/tech-trend.entity';
import Groq from 'groq-sdk';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class TrendsService {
  private readonly logger = new Logger(TrendsService.name);
  private groq: Groq;
  private isProcessing = false;

  // 파이프라인 수집 설정값
  private readonly TARGET_COUNT = 15; // 최종 저장할 개수
  private readonly LIMIT = 30; // 일단 긁어올 본문의 개수
  private readonly MIN_REACTIONS = 20; // 최소 좋아요 개수
  private readonly MIN_COMMENTS = 1; // 최소 댓글 개수
  private readonly MAX_SKIP_PAGES = 3; // 최대 스킵 페이지

  constructor(
    private readonly devToScraper: DevToScraper,
    @InjectRepository(TechTrend)
    private readonly techTrendRepository: Repository<TechTrend>,
  ) {
    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }

  // 특정 시간에 자동 실행(분 시 일 월 요일)
  @Cron('0 1 * * *', {
    name: 'devto-trends-collector',
    timeZone: 'Asia/Seoul',
  })
  async handleDailyTrendsCron() {
    this.logger.log('Cron : 수집 배치 작업을 시작합니다.');
    await this.collectAndProcessTrends();
  }

  private delaySeconds(seconds: number) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  // 외부 소스(DEV.to)에서 인기 글을 가져와 가공 후 DB에 저장
  async collectAndProcessTrends() {
    if (this.isProcessing) {
      this.logger.warn('이미 수집 파이프라인이 실행 중입니다. 중복 요청을 무시합니다.');
      return;
    }

    const processedUrls: string[] = []; // 저장된 글 목록의 URL 배열
    let currentPage = 1;
    let skipCount = 0;

    try {
      this.isProcessing = true;
      this.logger.log(`====== 신규 트렌드 목표 ${this.TARGET_COUNT}개 수집 시작 ======`);

      // 목표 개수를 다 채우거나, 연속 MAX_SKIP_PAGES 페이지가 전부 중복일 때까지 반복
      while (processedUrls.length < this.TARGET_COUNT && skipCount < this.MAX_SKIP_PAGES) {
      
      // 스크래퍼 호출
      const articles = await this.devToScraper.getTrendingArticles({
        page: currentPage,
        limit: this.LIMIT,
        minReactions: this.MIN_REACTIONS,
        minComments: this.MIN_COMMENTS,
      });

        let newArticlesInThisPageCount = 0; // 이번 페이지의 신규 글 개수

        for (const article of articles) {
          // 목표 개수(TARGET_COUNT) 채우면 즉시 중단
          if (processedUrls.length >= this.TARGET_COUNT) break;

          try {
            // DB 중복 체크
            const isExist = await this.techTrendRepository.findOne({
              where: { link_url: article.url },
            });
            if (isExist) {
              this.logger.log(`이미 수집된 링크 스킵: ${article.title}`);
              continue;
            }

            // 본문 수집
            const content = await this.devToScraper.getArticleContent(article.id);
            if (!content || content === '') {
              this.logger.warn(`ID: ${article.id} 글은 본문이 없어 요약을 건너뜁니다.`);
              continue;
            }

            // AI 요약
            this.logger.log(`AI 분석 중: ${article.title}`);
            const aiResult = await this.handleArticleSummary(article.title, content);
            if (!aiResult) {
              this.logger.error(`AI 요약 실패로 패스: ${article.title}`);
              continue;
            }

            // DB 저장
            const trendEntity = this.techTrendRepository.create({
              title: aiResult.title,
              link_url: article.url,
              summary: aiResult.summary,
              technical_tags: aiResult.tags,
              source: 'dev.to',
              created_at: new Date(article.created_at),
            });
            await this.techTrendRepository.save(trendEntity);

            processedUrls.push(article.url);
            newArticlesInThisPageCount++;

            this.logger.log(`저장 완료 (${processedUrls.length}/${this.TARGET_COUNT}): ${aiResult.title}`);
            this.logger.log(`다음 작업을 위해 5초 대기...`);
            await this.delaySeconds(5);

          } catch (error) {
            this.logger.error(`글 처리 중 에러 발생: ${article.title}`, error);
            await this.delaySeconds(5);
          }
        }

        // 이번 페이지에서 1개도 저장하지 못했으면 스킵 카운트 증가
        if (newArticlesInThisPageCount === 0) {
          skipCount++;
          this.logger.warn(`${currentPage}페이지는 신규 저장된 글이 없었습니다. (누적 스킵: ${skipCount}/${this.MAX_SKIP_PAGES})`);
        } else {
          skipCount = 0;
        }

        currentPage++;
      }

    } finally {
      this.isProcessing = false;
      this.logger.log(`====== 전체 파이프라인 처리 완료 (${processedUrls.length}개) ======`);
    }
  }

  // AI 요약 + 에러 처리 로직
  private async handleArticleSummary(
    title: string, 
    content: string, 
    retries = 2, 
    waitTime = 30, 
  ): Promise<{ title: string, summary: string[]; tags: string | null } | null> {
    try {
      return await this.executeAiSummary(title, content);
    } catch (error: any) {
      
      const is429 = error.status === 429 || error.error?.code === 429 || error.error?.status === 'RESOURCE_EXHAUSTED';

      if (is429 && retries > 0) {
        this.logger.warn(
          `API 한도 초과. ${waitTime}초 대기 후 재시도합니다. (남은 기회: ${retries}회)`
        );
        await this.delaySeconds(waitTime);
        return this.handleArticleSummary(title, content, retries - 1, waitTime);
      }

      this.logger.error(`AI 요약 최종 실패 (${title}): ${error.message || JSON.stringify(error)}`);
      return null;
    }
  }

  // 실제 AI 요약 로직
  private async executeAiSummary(title: string, content: string): Promise<{ title: string, summary: string[]; tags: string | null }> {
    const truncatedContent = content.length > 5000 
    ? content.substring(0, 5000) + '\n...(이하 생략)' 
    : content;

    const prompt = `
    당신은 해외 기술 블로그를 한국인 백엔드 개발자 시각에 맞게 요약하는 IT 트렌드 전문 에디터입니다.
    제공된 개발 블로그의 영문 제목과 본문을 분석하여 지정된 JSON 포맷으로 변환해 주세요.

    [글 정보]
    - 영문 제목: ${title}
    - 본문: ${truncatedContent}

    [작성 가이드라인]
    1. [title]: 영문 제목을 백엔드 개발자가 쉽게 알아볼 수 있는 기술 아티클 제목으로 가공하세요.
    - 소설이나 수필 같은 어색한 문장체(~했습니다, ~마주했다)는 자제하고, 핵심 기술/주제가 명확히 드러나는 직관적인 제목으로 만드세요.
    - 권장 형식: "[주제/기술스택] 핵심 문제 해결법 또는 가이드" 형태로 작성
    - 좋은 예시: 
      * "OpenTelemetry와 SigNoz를 활용한 AI 분석기 관측성 확보"
      * "사이버 보안 전략: AI 미끼를 활용한 네트워크 불법 감시자 포착"
      * "OpenAI 빌드 위크 및 $12K 펠로우십 프로그램 소개"
    2. summary: 본문의 핵심 내용을 친근한 존댓말 구어체(~해요, ~했습니다)로 구성된 한국어 표준어 3문장 리스트로 요약합니다.
    3. tags: 글과 관련된 주요 기술 스택을 쉼표로 구분한 문자열로 추출합니다. (예: "NestJS, Redis, TypeORM") 관련 스택이 없다면 null로 지정합니다.
    4. 언어 규칙: 모든 문자열은 한글 표준어와 영문 기술 용어(NestJS, Docker 등)로만 작성하며, CJK 한자(漢字) 및 어색한 직역 표현은 완벽히 exclusion 처리하여 순화된 한국어로 작성합니다.

    [응답 포맷 예시 (JSON)]
    {
      "title": "자연스러운 한국어 제목",
      "summary": [
        "첫 번째 핵심 요약 문장입니다.",
        "두 번째 핵심 요약 문장입니다.",
        "세 번째 핵심 요약 문장입니다."
      ],
      "tags": "Node.js, Docker"
    }
    `;

    const response = await this.groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_completion_tokens: 4096,
      reasoning_effort: 'none',
    });

    const rawText = response.choices[0]?.message?.content;
    if (!rawText) throw new Error('Groq 응답이 비어있습니다.');

    // 요약본 파싱 체크
    try {
      const parsed = JSON.parse(rawText);

      let formattedTags: string | null = null;
      if (Array.isArray(parsed.tags)) {
        formattedTags = parsed.tags.join(', ');
      } else if (typeof parsed.tags === 'string') {
        formattedTags = parsed.tags;
      }

      const formattedSummary = Array.isArray(parsed.summary)
        ? parsed.summary
        : [String(parsed.summary || '요약 내용 없음')];

      return {
        title: parsed.title || title,
        summary: formattedSummary,
        tags: formattedTags,
      };
    } catch (parseError: any) {
      throw new Error(`JSON 파싱 실패: ${parseError.message}`);
    }
  }
}