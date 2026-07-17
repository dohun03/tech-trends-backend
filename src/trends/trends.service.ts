import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DevToScraper } from './scrapers/devto.scraper';
// import { GoogleGenAI } from '@google/genai';
import { TechTrend } from 'database/entities/tech-trend.entity';
import Groq from 'groq-sdk';

@Injectable()
export class TrendsService {
  private readonly logger = new Logger(TrendsService.name);
  private groq: Groq;
  private isProcessing = false;

  constructor(
    private readonly devToScraper: DevToScraper,
    @InjectRepository(TechTrend)
    private readonly techTrendRepository: Repository<TechTrend>,
  ) {
    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 외부 소스(DEV.to)에서 인기 글을 가져와 가공 후 DB에 저장
  async collectAndProcessTrends() {
    if (this.isProcessing) {
      this.logger.warn('⚠️ 이미 수집 파이프라인이 실행 중입니다. 중복 요청을 무시합니다.');
      return;
    }

    const TARGET_COUNT = 15;
    const processedUrls: string[] = []; // 저장된 글 목록의 URL 배열
    let currentPage = 1;
    let SkitCount = 0;

    try {
      this.isProcessing = true;
      this.logger.log(`====== 신규 트렌드 ${TARGET_COUNT}개 수집 파이프라인 시작 ======`);

      // 목표 개수를 다 채우거나, 연속 5페이지가 전부 중복일 때까지 반복
      while (processedUrls.length < TARGET_COUNT && SkitCount < 5) {
        const articles = await this.devToScraper.getTrendingArticles(10, currentPage);
        if (!articles || articles.length === 0) {
          this.logger.error('❌ 더 이상 수집할 목록 데이터가 존재하지 않습니다.');
          break;
        }

        let newArticlesInThisPageCount = 0; // 이번 페이지의 신규 글 개수

        for (const article of articles) {
          if (processedUrls.length >= TARGET_COUNT) break;

          try {
            // DB 중복 체크
            const isExist = await this.techTrendRepository.findOne({
              where: { link_url: article.url }
            });
            if (isExist) {
              this.logger.log(`[스킵] 이미 수집된 링크입니다: ${article.title}`);
              await this.delay(1000);
              continue;
            }

            // 본문 스크래핑
            const content = await this.devToScraper.getArticleContent(article.id);
            if (!content || content === '본문 유실됨' || content === '') {
              this.logger.warn(`[본문 없음] ID: ${article.id} 글은 본문이 없어 요약을 건너뜁니다.`);
              continue;
            }

            // Gemini에게 한글 요약 및 기술 태그 추출 요청
            this.logger.log(`[AI 분석 중] 제목: ${article.title}`);
            const aiResult = await this.summarizeArticleWithAi(article.title, content);
            if (!aiResult) {
              this.logger.error(`❌ [AI 실패 스킵] 요약 실패로 패스: ${article.title}`);
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

            this.logger.log(`저장 완료 (${processedUrls.length}/${TARGET_COUNT}): ${aiResult.title}`);
            this.logger.log(`[대기] 다음 작업을 위해 5초 동안 대기합니다...`);
            await this.delay(5000);

          } catch (error) {
            this.logger.error(`글 처리 중 에러 발생: ${article.title}`, error);
            await this.delay(5000);
          }
        }

        // 만약 한 페이지에서 긁어온 글이 하나도 없다면
        if (newArticlesInThisPageCount === 0) {
          SkitCount++;
          this.logger.warn(`[경고] ${currentPage}페이지는 모든 글이 중복이었습니다. (누적 전체스킵: ${SkitCount}/5)`);
        } else {
          SkitCount = 0; // 하나라도 긁어왔으면 카운터 초기화
        }

        currentPage++;
      }

    } finally {
      this.isProcessing = false;
      this.logger.log(`====== 전체 파이프라인 처리 완료 (${processedUrls.length}개) ======`);
    }
  }

  // AI 요약 + 에러 처리 로직
  private async summarizeArticleWithAi(
    title: string, 
    content: string, 
    retries = 2, 
    waitTime = 30000 // 기본 30초 대기
  ): Promise<{ title: string, summary: string[]; tags: string | null } | null> {
    try {
      return await this.executeGroqCall(title, content);
    } catch (error: any) {
      
      const is429 = error.status === 429 || error.error?.code === 429 || error.error?.status === 'RESOURCE_EXHAUSTED';

      if (is429 && retries > 0) {
        this.logger.warn(
          `⚠️ [429 Quota] API 한도 초과. ${waitTime / 1000}초 대기 후 재시도합니다. (남은 기회: ${retries}회)`
        );
        await this.delay(waitTime);
        return this.summarizeArticleWithAi(title, content, retries - 1, waitTime * 1.5);
      }

      this.logger.error(`❌ AI 요약 최종 실패 (${title}): ${error.message || JSON.stringify(error)}`);
      return null;
    }
  }

  // 실제 AI 요약 로직
  private async executeGroqCall(title: string, content: string): Promise<{ title: string, summary: string[]; tags: string | null }> {
    const prompt = `
    당신은 글로벌 IT 기술 블로그를 한국인 백엔드 개발자 시점에서 가공하는 기술 트렌드 요약 전문가입니다.
    제공된 개발 블로그 글의 영문 제목과 본문을 분석하여 규칙에 맞게 처리해주세요.
    
    [중요 규칙]
    결과는 반드시 지정된 JSON 포맷으로 반환해야 합니다. (You must respond strictly in JSON format)

    [글 정보]
    영문 제목: ${title}
    본문: ${content}

    [요구사항 및 품질 가이드라인]
    1. [title]: 영문 제목을 한국어 개발자 정서에 맞게 자연스럽고 매끄럽게 번역하세요. 
       - 직역보다는 "NestJS에서 Redis Write-Back 캐시 적용하기" 처럼 기술 키워드가 살도록 제목을 구성하세요.
    2. [summary]: 본문 내용을 핵심 위주로 명확하게 요약하여 **정확히 한글 3문장**의 리스트로 작성하세요.
       - 말투: 딱딱하고 어색한 직역체나 명사형 종결(~함, ~임)은 절대 금지합니다. 친근하고 부드러운 존댓말 구어체(~해요, ~했습니다)를 사용하세요.
       - 언어 제한: 오직 한글(표준 한국어)만 사용하세요. 한자(漢字)나 일본어식 번역 표현은 절대 섞지 말고 순화된 표현을 사용하세요.
    3. [tags]: 관련 있는 핵심 기술 스택이나 키워드가 있다면 쉼표(,)로 구분된 태그 문자열을 만들어주세요. (예: "NestJS, Redis, TypeORM") 없으면 null로 지정하세요.

    [반환 형식 예시]
    {
      "title": "자연스럽게 번역된 한글 제목",
      "summary": [
        "첫 번째 핵심 요약 문장입니다.",
        "두 번째 핵심 요약 문장입니다.",
        "세 번째 핵심 요약 문장입니다."
      ],
      "tags": "Node.js, Docker"
    }
    `;

    const response = await this.groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const rawText = response.choices[0]?.message?.content;
    if (!rawText) throw new Error('Groq 응답이 비어있습니다.');

    const parsed = JSON.parse(rawText);
    return {
      title: parsed.title || title,
      summary: parsed.summary || ['요약 생성 실패'],
      tags: parsed.tags || null
    };
  }
}