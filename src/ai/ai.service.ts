import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import {
  BatchEvaluationResult,
  FilterBatchParams,
  FinalSummaryResult,
  SummarizeContentParams,
  VectorEmbeddingParams,
} from './interfaces/ai.interface';
import { RedisService } from 'redis/redis.service';
import { ConfigService } from '@nestjs/config';

interface ExecuteWithRetryParams<T> {
  operation: () => Promise<T>;
  context: string;
  maxRetries?: number;
  baseDelayMs?: number;
}

interface WaitForCacheParams {
  cacheKey: string;
  maxRetries?: number;
  delayMs?: number;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private groq: Groq;
  private gemini: GoogleGenAI;
  
  private readonly groqModelName: string;
  private readonly embeddingModelName: string;
  private readonly embeddingTtlSeconds: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.groqModelName = this.configService.getOrThrow('GROQ_MODEL');
    this.embeddingModelName = this.configService.getOrThrow('GEMINI_EMBEDDING_MODEL');
    this.embeddingTtlSeconds = Number(this.configService.get('EMBEDDING_TTL_SECONDS')) || 2592000;

    this.groq = new Groq({
      apiKey: this.configService.get<string>('GROQ_API_KEY'),
    });

    this.gemini = new GoogleGenAI({
      apiKey: this.configService.get<string>('GEMINI_API_KEY'),
    });
  }

  // [공통 재시도 로직] 객체 파라미터 적용
  private async executeWithRetry<T>(params: ExecuteWithRetryParams<T>): Promise<T> {
    const { operation, context, maxRetries = 3, baseDelayMs = 2000 } = params;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 성공: 해당 함수 실행 후 그대로 반환
        return await operation();
      } catch (error: any) {
        // 실패: 재시도 로직
        if (attempt === maxRetries) {
          this.logger.error(`[Retry:${context}] 최종 실패 (재시도 ${attempt}회 초과) | error=${error.message}`);
          throw error;
        }

        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        this.logger.warn(`[Retry:${context}] 실패, ${delay}ms 후 재시도 (${attempt}/${maxRetries}) | error=${error.message}`);
        
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('Unreachable code');
  }

  // GROQ(QWEN) AI 평가 (객체 파라미터)
  async filterBatchWithAi(params: FilterBatchParams): Promise<string[]> {
    const { items } = params;

    const prompt = `
    당신은 백엔드 개발자 시각의 IT 트렌드 큐레이터입니다.
    아래 10개 아티클 목록(제목 및 800자 요약)을 읽고,
    백엔드/DevOps/CS/개발기술 측면에서 실무에 도움이 되는 가치 있는 글의 ID만 선택하세요.

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
      const parsed = await this.executeWithRetry({
        operation: async () => {
          const response = await this.groq.chat.completions.create({
            model: this.groqModelName,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.1,
            max_completion_tokens: 4096,
            reasoning_effort: 'none',
          });

          const raw = response.choices[0]?.message?.content;
          if (!raw) throw new Error('AI 응답이 비어 있습니다.');

          return JSON.parse(raw) as BatchEvaluationResult;
        },
        context: 'Groq-FilterBatch',
      });

      return parsed.valuable_ids || [];
    } catch (error: any) {
      this.logger.error(`[AI:Groq] 배치 가치 평가 최종 실패. | error=${error.message}`);
      throw error;
    }
  }

  // GROQ(QWEN) AI 요약 (객체 파라미터)
  async summarizeContentWithAi(params: SummarizeContentParams): Promise<FinalSummaryResult | null> {
    const { title, content } = params;

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
      const parsed = await this.executeWithRetry({
        operation: async () => {
          const response = await this.groq.chat.completions.create({
            model: this.groqModelName,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_completion_tokens: 4096,
            reasoning_effort: 'none',
          });

          const raw = response.choices[0]?.message?.content;
          if (!raw) throw new Error('AI 응답이 비어 있습니다.');

          return JSON.parse(raw);
        },
        context: `Groq-Summarize:${title.substring(0, 20)}`,
      });

      return {
        title: parsed.title || title,
        short_summary: Array.isArray(parsed.short_summary)
          ? parsed.short_summary
          : [parsed.short_summary],
        long_summary: parsed.long_summary || '',
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.join(', ')
          : parsed.tags || null,
      };
    } catch (error: any) {
      this.logger.error(`[AI:Groq] 단일 아티클 요약 최종 실패. | title="${title}", error=${error.message}`);
      throw error;
    }
  }

  // GEMINI AI 벡터 임베딩
  async vectorEmbeddingWithAi({
    texts,
    taskType = 'RETRIEVAL_DOCUMENT',
  }: VectorEmbeddingParams): Promise<number[][]> {
    if (!texts || texts.length === 0) return [];

    try {
      const embeddings = await this.executeWithRetry({
        operation: async () => {
          const response = await this.gemini.models.embedContent({
            model: this.embeddingModelName,
            contents: texts,
            config: {
              outputDimensionality: 1536,
              taskType,
            },
          });

          if (!response.embeddings || response.embeddings.length === 0) {
            throw new Error('임베딩 결과가 비어 있습니다.');
          }

          return response.embeddings;
        },
        context: 'Gemini-Embedding',
        baseDelayMs: 3000,
      });

      return embeddings.map((embedding) => embedding.values || []);
    } catch (error: any) {
      this.logger.error(`[AI:Gemini] 임베딩 일괄 생성 최종 실패. | error=${error.message}`);
      throw error;
    }
  }

  // GEMINI AI 벡터 임베딩 (검색 기능)
  async embedSearchQuery(query: string): Promise<number[] | null> {
    if (!query || !query.trim()) return null;

    const normalizedQuery = this.normalizeKeyword(query);
    const cacheKey = `emb:${this.embeddingModelName}:${normalizedQuery}`;
    const lockKey = `lock:${cacheKey}`;

    try {
      // Redis 캐시 확인
      const cachedVector = await this.redisService.getCache<number[]>({ key: cacheKey });
      if (cachedVector && Array.isArray(cachedVector) && cachedVector.length > 0) {
        this.logger.log(`[Embedding Cache HIT] key="${cacheKey}"`);
        return cachedVector; // 캐시값 바로 리턴
      }

      // 락 획득 시도 (UUID 토큰 획득)
      const lockValue = await this.redisService.acquireLock({
        key: lockKey,
        ttlMs: 10000, // 10초
      });

      if (!lockValue) {
        this.logger.log(`[Embedding Lock Waiting] 다른 요청이 캐시 생성 중입니다. key="${cacheKey}"`);
        return await this.waitForCache({ cacheKey });
      }

      // 락 획득 성공
      try {
        this.logger.log(`[Embedding Cache MISS] API 호출 진행 (락 선점) key="${cacheKey}"`);
        const vectors = await this.vectorEmbeddingWithAi({
          texts: [normalizedQuery],
          taskType: 'RETRIEVAL_QUERY',
        });

        const vector = vectors.length > 0 && vectors[0].length > 0 ? vectors[0] : null;

        if (vector) {
          await this.redisService.setCache({
            key: cacheKey,
            value: vector,
            ttlSeconds: this.embeddingTtlSeconds,
          });
        }

        return vector;
      } finally {
        // 캐싱 완료 후 락 해제
        await this.redisService.releaseLock({
          key: lockKey,
          value: lockValue,
        });
      }
    } catch (error: any) {
      this.logger.error(`[embedSearchQuery] 처리 중 에러 발생: ${error.message}`);
      return null;
    }
  }

  // 검색 키워드 정규화
  private normalizeKeyword(keyword: string): string {
    return keyword
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  // 검색 중복 요청시 대기
  private async waitForCache(params: WaitForCacheParams): Promise<number[] | null> {
    const { cacheKey, maxRetries = 25, delayMs = 200 } = params;

    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      const cachedVector = await this.redisService.getCache<number[]>({ key: cacheKey });
      if (cachedVector && Array.isArray(cachedVector) && cachedVector.length > 0) {
        this.logger.log(`[Embedding Lock Resolved] 대기 후 캐시 획득 성공! key="${cacheKey}"`);
        return cachedVector;
      }
    }

    this.logger.warn(`[Embedding Lock Timeout] 대기 시간 초과. fallback 처리 key="${cacheKey}"`);
    return null;
  }
}