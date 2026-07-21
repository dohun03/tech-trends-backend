import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DevToScraper } from './scrapers/devto.scraper';
import { TechTrend } from 'database/entities/tech-trend.entity';
import Groq from 'groq-sdk';
import { Cron } from '@nestjs/schedule';

// AI 응답 타입 정의
interface AiSummaryResponse {
  is_valuable: boolean;
  title: string;
  summary: string[];
  tags: string | null;
}

@Injectable()
export class TrendsService {
  private readonly logger = new Logger(TrendsService.name);
  private groq: Groq;
  private isProcessing = false;

  // 파이프라인 수집 설정값
  private readonly TARGET_COUNT = 15; // 최종 저장할 개수
  private readonly LIMIT = 30; // 일단 긁어올 본문의 개수
  private readonly MIN_REACTIONS = 10; // 최소 좋아요 개수
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

  // 딜레이 기능
  private delaySeconds(seconds: number) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  // 본문 전처리
  private sanitizeContent(markdown: string): string {
    if (!markdown) return '';

    return markdown
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/```[\s\S]*?```/g, '[코드 블록 생략]')
      .replace(/<[^>]*>?/gm, '')
      .replace(/\|?\s*:-+:?\s*\|?/g, '')
      .replace(/^-{3,}$/gm, '')
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
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

          let isApiCalled = false; // 외부 API를 찔렀는지 여부

          try {
            // DB 중복 체크
            const isExist = await this.techTrendRepository.findOne({
              where: { link_url: article.url },
            });
            if (isExist) {
              this.logger.log(`이미 수집된 링크 스킵: ${article.title}`);
              continue;
            }

            isApiCalled = true;

            // 본문 수집
            const content = await this.devToScraper.getArticleContent(article.id);
            if (!content || content === '') {
              this.logger.warn(`ID: ${article.id} 글은 본문이 없어 요약을 건너뜁니다.`);
              continue;
            }

            // 본문 전처리
            const sanitizedContent = this.sanitizeContent(content);

            // AI 요약
            const aiResult = await this.handleArticleSummary(article.title, sanitizedContent);

            if (!aiResult) {
              this.logger.warn(`AI 요약 실패 스킵: ${article.title}`);
              continue;
            }

            if (!aiResult.is_valuable) {
              this.logger.warn(`정보 가치가 없는 잡설/회고글 스킵: ${article.title}`);
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

          } catch (error) {
            this.logger.error(`글 처리 중 에러 발생: ${article.title}`, error);
          } finally {
            if (isApiCalled) {
              this.logger.log(`다음 작업을 위해 5초 대기...`);
              await this.delaySeconds(5);
            }
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
  ): Promise<AiSummaryResponse | null> {
    try {
      this.logger.log(`AI 분석 중: ${title}`);
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
  private async executeAiSummary(title: string, content: string): Promise<AiSummaryResponse> {
    const truncatedContent = content.length > 5000 
    ? content.substring(0, 5000) + '\n...(이하 생략)' 
    : content;

    const prompt = `
    당신은 해외 기술 블로그를 한국인 백엔드 개발자 시각에 맞게 요약하는 IT 트렌드 전문 에디터입니다.
    제공된 개발 블로그의 영문 제목과 본문을 분석하여 지정된 JSON 포맷으로 변환해 주세요.

    [글 정보]
    - 영문 제목: ${title}
    - 본문: ${truncatedContent}

    [유효성 판별 기준 (is_valuable)]
    아래 기준 중 하나라도 해당되면 "is_valuable": false 로 지정하세요.
    - 단순 개발자 회고, 수필, 커리어 고민, 소소한 일상 이야기(잡설)
    - 기술적 깊이나 유용한 정보가 없는 단순 광고, 프로모션글
    - 코딩/개발/IT 아키텍처/DevOps/CS 지식과 관련 없는 글
    * 실제 개발 기술, 튜토리얼, 아키텍처 설계, 신기술 소식, 성능 최적화 등 "개발자에게 유용한 정보"일 때만 "is_valuable": true 로 지정합니다.

    [작성 가이드라인 (is_valuable이 true일 때만 유효)]
    1. title: 영문 제목을 한국인 백엔드 개발자가 쉽게 알아볼 수 있는 기술 아티클 제목으로 가공합니다.
    - 소설이나 수필 같은 어색한 문장체(~했습니다, ~마주했다)는 자제하고, 핵심 기술/주제가 명확히 드러나는 직관적인 제목으로 만드세요.
    - 예시: "OpenTelemetry와 SigNoz를 활용한 AI 분석기 관측성 확보"
    2. summary: 핵심 내용을 친근한 존댓말(~해요, ~했습니다) 3문장 리스트로 요약
    3. tags: 주요 기술 스택 쉼표 구분 문자열 (예: "NestJS, Redis")

    [응답 포맷 예시 (JSON)]
    - 유용한 기술 글인 경우:
    {
      "is_valuable": true,
      "title": "OpenTelemetry와 SigNoz를 활용한 관측성 확보",
      "summary": ["첫 번째 문장.", "두 번째 문장.", "세 번째 문장."],
      "tags": "OpenTelemetry, Node.js"
    }

    - 유용하지 않거나 잡설인 경우:
    {
      "is_valuable": false,
      "title": "",
      "summary": [],
      "tags": null
    }
    `;

    const response = await this.groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_completion_tokens: 4096,
      reasoning_effort: 'none',
    });

    const rawText = response.choices[0]?.message?.content;
    if (!rawText) throw new Error('Groq 응답이 비어있습니다.');

    // 요약본 파싱 체크
    try {
      const parsed = JSON.parse(rawText);

      // AI가 유용하지 않은 글이라고 판단한 경우
      if (parsed.is_valuable === false) {
        return {
          is_valuable: false,
          title: '',
          summary: [],
          tags: null,
        };
      }

      // 태그 포맷팅 검증
      let formattedTags: string | null = null;
      if (Array.isArray(parsed.tags)) {
        formattedTags = parsed.tags.join(', ');
      } else if (typeof parsed.tags === 'string') {
        formattedTags = parsed.tags;
      }

      // 요약문 배열 포맷팅 검증
      const formattedSummary = Array.isArray(parsed.summary)
        ? parsed.summary
        : [String(parsed.summary || '요약 내용 없음')];

      return {
        is_valuable: true,
        title: parsed.title || title,
        summary: formattedSummary,
        tags: formattedTags,
      };
    } catch (parseError: any) {
      throw new Error(`JSON 파싱 실패: ${parseError.message}`);
    }
  }
}